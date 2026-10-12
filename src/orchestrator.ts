/** One execution path for normalized single, parallel, chain, and background plans. */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecutionPlan } from "./plan.ts";
import { expandTask } from "./plan.ts";
import { Runner, mapWithConcurrencyLimit } from "./runner.ts";
import { claimWorktree, registerWorktree } from "./store.ts";
import { aggregateUsage, getResultOutput, toModelUsage, truncateToBytes } from "./format.ts";
import { newRunRecord, type RunRecord, type SubagentDetails, type WorktreeInfo } from "./types.ts";
import { createWorktree } from "./worktree.ts";

export function resultFor(details: SubagentDetails): AgentToolResult<SubagentDetails> {
	const outputs = details.results.map((r) => {
		const output = r.parsedOutput === undefined ? getResultOutput(r) : JSON.stringify(r.parsedOutput, null, 2);
		const clipped = truncateToBytes(output, 50 * 1024);
		const artifact = r.artifacts
			? {
					...r.artifacts,
					changedFiles: r.artifacts.changedFiles.slice(0, 100),
					verification: r.artifacts.verification
						.slice(-10)
						.map((v) => ({ command: truncateToBytes(v.command, 1024).text, exitCode: v.exitCode, isError: v.isError })),
					changedFileCount: r.artifacts.changedFiles.length,
					commandCount: r.artifacts.verification.length,
				}
			: undefined;
		const metadata = {
			runId: r.id,
			status: r.status,
			cwd: r.cwd,
			sessionFile: r.sessionFile,
			worktree: r.worktree,
			artifacts: artifact,
			usage: r.usage,
			error: r.errorMessage,
		};
		return `### ${r.agent}: ${r.status}\n${clipped.text}${clipped.truncated ? "\n[Output truncated; full output is in the saved run.]" : ""}\n\nRun metadata:\n${JSON.stringify(metadata, null, 2)}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `${details.mode}: ${details.status ?? "running"}${details.errorMessage ? ` — ${details.errorMessage}` : ""}\n\n${outputs.join("\n\n")}`,
			},
		],
		details,
		usage: toModelUsage(aggregateUsage(details.results)),
	};
}

export async function executePlan(
	plan: ExecutionPlan,
	runner: Runner,
	signal?: AbortSignal,
	onUpdate?: (result: AgentToolResult<SubagentDetails>) => void,
): Promise<AgentToolResult<SubagentDetails>> {
	const details: SubagentDetails = {
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
