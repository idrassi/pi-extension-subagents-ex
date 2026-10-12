import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { validateOutputSchema } from "./contracts.ts";
import { getFinalOutput } from "./format.ts";
import type { Isolation, OutputFormat, RunDefaults, RunMode, RunOverrides, RunRecord } from "./types.ts";
import { MAX_CHAIN_STEPS, MAX_PARALLEL_TASKS, validateControls, validatePrompt } from "./validation.ts";

export interface TaskInput {
	agent: string;
	task: string;
	cwd?: string;
	isolation?: Isolation;
	model?: string;
	thinking?: ThinkingLevel;
	timeout?: number;
	maxTurns?: number;
	retries?: number;
	maxCost?: number;
}

export interface PlanInput extends Partial<TaskInput> {
	tasks?: TaskInput[];
	chain?: TaskInput[];
	outputFormat?: OutputFormat;
	outputSchema?: Record<string, unknown>;
	agentScope?: AgentScope;
	runInBackground?: boolean;
	notify?: boolean;
	resume?: string;
}

export interface PlannedTask {
	agent: AgentConfig;
	task: string;
	overrides: RunOverrides;
}

export interface ExecutionPlan {
	mode: RunMode;
	steps: PlannedTask[];
	defaults: RunDefaults;
	chainIsolation: Isolation;
	cwd: string;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	resumeFrom?: RunRecord;
}

/** Resolve and validate everything before worktrees, processes, or detached tasks exist. */
export function buildPlan(
	input: PlanInput,
	agents: AgentConfig[],
	defaults: RunDefaults,
	projectAgentsDir: string | null,
	resumeFrom?: RunRecord,
): ExecutionPlan {
	const hasChain = input.chain !== undefined;
	const hasTasks = input.tasks !== undefined;
	const hasSingle = input.agent !== undefined || input.task !== undefined || input.resume !== undefined;
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1)
		throw new Error("Provide exactly one of (agent + task), tasks, or chain");
	if (input.resume && !resumeFrom) throw new Error(`Unknown saved run: ${input.resume}`);
	if (resumeFrom && (!resumeFrom.sessionFile || !resumeFrom.endedAt))
		throw new Error("Only a settled run with a saved child session can be resumed");
	if (resumeFrom && input.agent && input.agent !== resumeFrom.agent)
		throw new Error("Resuming cannot change the agent identity");
	if (resumeFrom && (input.cwd || input.isolation))
		throw new Error("A resumed run retains its original working directory and worktree");
	const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
	const items = hasChain
		? input.chain!
		: hasTasks
			? input.tasks!
			: [{ ...input, agent: input.agent ?? resumeFrom?.agent ?? "", task: input.task ?? "" }];
	const limit = mode === "parallel" ? MAX_PARALLEL_TASKS : MAX_CHAIN_STEPS;
	if (!items.length || items.length > limit) throw new Error(`${mode} requires 1–${limit} tasks`);
	const cwd = resumeFrom?.cwd ?? path.resolve(defaults.cwd, input.cwd ?? ".");
	const outputSchema = input.outputSchema ?? resumeFrom?.outputSchema;
	if (outputSchema) validateOutputSchema(outputSchema);
	validateControls({
		timeoutSeconds: input.timeout,
		maxTurns: input.maxTurns,
		retries: input.retries,
		maxCost: input.maxCost,
	});
	const steps = items.map((item, index): PlannedTask => {
		if (mode === "chain" && item.isolation !== undefined)
			throw new Error("Set isolation on the chain, not on individual steps");
		const agent = agents.find((a) => a.name === item.agent);
		if (!agent) throw new Error(`Unknown agent: "${item.agent}". Available: ${agents.map((a) => a.name).join(", ")}`);
		validatePrompt(item.task);
		if (mode === "chain")
			for (const match of item.task.matchAll(/\{steps\.(\d+)\}/g)) {
				if (Number(match[1]) >= index) throw new Error(`Chain step ${index} references unavailable step ${match[1]}`);
			}
		const overrides: RunOverrides = {
			cwd: resumeFrom?.cwd ?? (mode === "single" ? cwd : path.resolve(cwd, item.cwd ?? ".")),
			model: item.model ?? input.model ?? resumeFrom?.model ?? agent.model ?? defaults.model,
			thinking: item.thinking ?? input.thinking ?? agent.thinking ?? defaults.thinkingLevel,
			timeoutSeconds: item.timeout ?? input.timeout ?? agent.timeoutSeconds,
			maxTurns: item.maxTurns ?? input.maxTurns ?? agent.maxTurns,
			retries: item.retries ?? input.retries ?? agent.retries ?? 0,
			maxCost: item.maxCost ?? input.maxCost,
			isolation: mode === "chain" ? "none" : (item.isolation ?? input.isolation ?? "none"),
			outputFormat:
				mode === "chain" && index !== items.length - 1
					? "text"
					: outputSchema
						? "json"
						: (input.outputFormat ?? resumeFrom?.outputFormat ?? "text"),
			outputSchema: mode === "chain" && index !== items.length - 1 ? undefined : outputSchema,
			resumeFrom,
			worktree: resumeFrom?.worktree,
		};
		validateControls(overrides);
		return { agent, task: item.task, overrides };
	});
	return {
		mode,
		steps,
		defaults,
		cwd,
		chainIsolation: mode === "chain" ? (input.isolation ?? "none") : "none",
		agentScope: input.agentScope ?? "user",
		projectAgentsDir,
		resumeFrom,
	};
}

/** One pass, with literal substitutions; inserted content is never re-expanded. */
export function expandTask(template: string, results: RunRecord[]): string {
	return template.replace(/\{previous\}|\{steps\.(\d+)\}/g, (match, n: string | undefined) => {
		const index = match === "{previous}" ? results.length - 1 : Number(n);
		if (index === -1) return "";
		const record = results[index];
		if (!record) throw new Error(`Chain references unavailable step ${index}`);
		return getFinalOutput(record.messages);
	});
}
