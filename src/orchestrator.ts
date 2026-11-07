/** One execution path for normalized single, parallel, chain, and background plans. */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecutionPlan } from "./plan.ts";
import { expandTask } from "./plan.ts";
import { Runner, mapWithConcurrencyLimit } from "./runner.ts";
import { claimWorktree, registerWorktree } from "./store.ts";
import { aggregateUsage, toModelUsage } from "./format.ts";
import { boundedResult, compactDetails } from "./results.ts";
import { newRunRecord, type RunRecord, type SubagentDetails, type WorktreeInfo } from "./types.ts";
import { createWorktree } from "./worktree.ts";

export function resultFor(details: SubagentDetails): AgentToolResult<SubagentDetails> {
	const published = compactDetails(details);
	const outputs = published.results.map((run) => {
		const refs = [
			`Run: ${run.id}${run.treeId ? ` (tree ${run.treeId})` : ""}`,
			...(["output", "manifest", "patch"] as const).flatMap((key) =>
				run.artifacts?.[key] ? [`${key}: ${run.artifacts[key]}`] : [],
			),
			...(run.sessionFile ? [`session: ${run.sessionFile}`] : []),
			...(run.cwd ? [`cwd: ${run.cwd}`] : []),
		];
		return `### ${run.agent}: ${run.status}\n${run.output ?? "(no output preview)"}${run.errorMessage && run.status !== "ok" ? `\nError: ${run.errorMessage}` : ""}\n\n${refs.join("\n")}`;
	});
	return boundedResult(
		`${published.mode}: ${published.status ?? "running"}${published.errorMessage ? ` — ${published.errorMessage}` : ""}\n\n${outputs.join("\n\n")}\n\nFull output: subagent_run_output with a run ID; previews are not output contracts.`,
		published,
		toModelUsage(aggregateUsage(details.results)),
	);
}

export async function executePlan(
	plan: ExecutionPlan,
	runner: Runner,
	signal?: AbortSignal,
	onUpdate?: (result: AgentToolResult<SubagentDetails>) => void,
): Promise<AgentToolResult<SubagentDetails>> {
	// Execution state stays full fidelity for chain placeholders and contracts.
	// Only resultFor/onUpdate publication projects records to compact DTOs.
	const details: Omit<SubagentDetails, "results"> & { results: RunRecord[] } = {
		mode: plan.mode,
		agentScope: plan.agentScope,
		projectAgentsDir: plan.projectAgentsDir,
		results: [],
		status: "running",
	};
	let worktree: WorktreeInfo | undefined;
	let releaseWorktree: (() => Promise<void>) | undefined;
	const update = () => onUpdate?.(resultFor({ ...details, results: [...details.results] }));
	try {
		signal?.throwIfAborted();
		if (plan.chainIsolation === "worktree") {
			const id = `chain-${randomUUID()}`;
			worktree = await createWorktree(plan.cwd, id);
			registerWorktree(id, worktree);
			releaseWorktree = await claimWorktree(worktree, id);
		}
		const runStep = async (index: number): Promise<RunRecord> => {
			const step = plan.steps[index];
			const overrides = { ...step.overrides };
			if (worktree) {
				const relative = path.relative(worktree.repoRoot, overrides.cwd!);
				if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
					throw new Error("Chain step cwd must remain inside the isolated repository");
				overrides.cwd = path.join(worktree.path, relative);
				overrides.worktree = worktree;
			}
			const task = plan.mode === "chain" ? expandTask(step.task, details.results) : step.task;
			return runner.run(
				plan.defaults,
				step.agent,
				task,
				overrides,
				plan.mode === "chain" ? index + 1 : undefined,
				signal,
				(r) => {
					details.results[index] = r;
					update();
				},
			);
		};
		if (plan.mode === "parallel") {
			details.results = plan.steps.map((s) =>
				newRunRecord(`run-${randomUUID()}`, s.agent.name, s.agent.source, s.task, s.overrides.cwd!),
			);
			// The shared scheduler owns concurrency, including other calls and descendants.
			details.results = await mapWithConcurrencyLimit(plan.steps, plan.steps.length, async (_step, index) => {
				try {
					return await runStep(index);
				} catch (err) {
					const r = details.results[index];
					r.status = signal?.aborted ? "aborted" : "error";
					r.errorMessage = String(err);
					r.endedAt = Date.now();
					return r;
				}
			});
		} else {
			for (let i = 0; i < plan.steps.length; i++) {
				const record = await runStep(i);
				details.results[i] = record;
				if (record.status !== "ok") break;
			}
		}
		const failed = details.results.filter((r) => r.status !== "ok").length;
		details.status = signal?.aborted
			? "aborted"
			: failed
				? plan.mode === "parallel" && failed < details.results.length
					? "partial"
					: "error"
				: "ok";
	} catch (err) {
		details.status = signal?.aborted ? "aborted" : "error";
		details.errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		try {
			await releaseWorktree?.();
		} catch (err) {
			details.status = "error";
			details.errorMessage = `Worktree release failed: ${String(err)}`;
		}
	}
	return resultFor(details);
}
