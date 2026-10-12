/**
 * Shared types for the subagents-ex orchestration engine.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export type AgentSource = "bundled" | "user" | "project" | "unknown";
export type RunMode = "single" | "parallel" | "chain";
export type RunStatus =
	| "queued"
	| "running"
	| "ok"
	| "error"
	| "timeout"
	| "max-turns"
	| "budget"
	| "aborted"
	| "interrupted";
export type Isolation = "none" | "worktree";
export type OutputFormat = "text" | "json";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	repoRoot: string;
	/** Starting commit; patches include committed and uncommitted worker edits. */
	baseCommit?: string;
	/** Relative cwd within the checkout. */
	subdirectory?: string;
}

export interface VerificationEvidence {
	command: string;
	exitCode?: number;
	isError?: boolean;
	output: string;
}

export interface RunArtifacts {
	manifest?: string;
	patch?: string;
	changedFiles: string[];
	baseCommit?: string;
	verification: VerificationEvidence[];
}

export interface AttemptRecord {
	number: number;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	diagnostics: string[];
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	sessionFile: string;
}

/**
 * One executed (or in-flight) agent run.
 */
export interface RunRecord {
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	cwd: string;
	status: RunStatus;
	/** 1-based step index for chain runs. */
	step?: number;
	/** Number of attempts started (0 while queued). */
	attempts: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	ownerPid?: number;
	childPid?: number;
	/** Present when the run executed inside a dedicated git worktree. */
	worktree?: WorktreeInfo;
	/** Parsed JSON final output when outputFormat: "json" was requested. */
	parsedOutput?: unknown;
	attemptHistory?: AttemptRecord[];
	sessionFile?: string;
	resumeOf?: string;
	treeId?: string;
	parentRunId?: string;
	artifacts?: RunArtifacts;
	outputFormat?: OutputFormat;
	outputSchema?: Record<string, unknown>;
}

export interface SubagentDetails {
	mode: RunMode | "background";
	agentScope: string;
	projectAgentsDir: string | null;
	results: RunRecord[];
	/** Background task id (mode === "background"). */
	taskId?: string;
	notify?: boolean;
	status?: "running" | "ok" | "partial" | "error" | "aborted";
	errorMessage?: string;
}

export interface RunOverrides {
	cwd?: string;
	model?: string;
	thinking?: ThinkingLevel;
	timeoutSeconds?: number;
	maxTurns?: number;
	retries?: number;
	isolation?: Isolation;
	outputFormat?: OutputFormat;
	outputSchema?: Record<string, unknown>;
	maxCost?: number;
	worktree?: WorktreeInfo;
	resumeFrom?: RunRecord;
}

export interface RunDefaults {
	cwd: string;
	/** Dispatcher session model ("provider/id") inherited when the agent doesn't pin one. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Nesting depth of the current process (0 = top-level interactive pi). */
	depth: number;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function newRunRecord(
	id: string,
	agent: string,
	agentSource: AgentSource,
	task: string,
	cwd: string,
	step?: number,
): RunRecord {
	return {
		id,
		agent,
		agentSource,
		task,
		cwd,
		status: "queued",
		step,
		attempts: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		startedAt: Date.now(),
	};
}

export function isRunFailed(record: RunRecord): boolean {
	return record.status !== "ok" && record.status !== "running" && record.status !== "queued";
}
