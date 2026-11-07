/** Pure, bounded publication helpers. Full transcripts belong in the run/session store. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { truncateToBytes } from "./format.ts";
import type { RunRecord, RunResult, RunResultArtifacts, SubagentDetails, UsageStats, WorktreeInfo } from "./types.ts";

/** Includes JSON framing, details, escaped content and SDK usage, not just prose. */
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_RESULT_TEXT_BYTES = 32 * 1024;
export const MAX_RESULT_TEXT_LINES = 1000;
export const MAX_RESULT_DETAILS_BYTES = 30 * 1024;
export const MAX_RUN_OUTPUT_BYTES = 4 * 1024;
export const MAX_RUN_OUTPUT_LINES = 160;
export const MAX_RUN_METADATA_BYTES = 1024;
export const MAX_ARTIFACT_ITEMS = 8;
export const RESULT_TRUNCATION_NOTICE =
	"[Truncated; request a smaller page or use subagent_run_output with the run ID. Full output remains in the saved run/session or output artifacts.]";

const OMITTED = "[omitted]";
const PATH_BYTES = 1024;
const LABEL_BYTES = 128;

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** The notice is inside both budgets, including when the limit is a line limit. */
function preview(text: string, maxBytes: number, maxLines: number, forceNotice = false): { text: string; truncated: boolean } {
	const linePrefix = (value: string, lines: number): string => {
		let end = -1;
		for (let i = 0; i < lines; i++) {
			end = value.indexOf("\n", end + 1);
			if (end === -1) return value;
		}
		return value.slice(0, end);
	};
	const head = linePrefix(text, maxLines);
	if (!forceNotice && head === text && Buffer.byteLength(text, "utf8") <= maxBytes)
		return { text, truncated: false };
	const fullNotice = `\n\n${RESULT_TRUNCATION_NOTICE}`;
	const suffix = Buffer.byteLength(fullNotice) <= maxBytes ? fullNotice : "\n[Truncated]";
	// Text results reserve the full notice; tiny metadata labels use the short one.
	const prefix = truncateToBytes(linePrefix(text, Math.max(1, maxLines - 2)), Math.max(0, maxBytes - Buffer.byteLength(suffix))).text;
	return { text: `${prefix}${suffix}`, truncated: true };
}

function copyUsage(usage: UsageStats): UsageStats {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
		contextTokens: usage.contextTokens,
		turns: usage.turns,
	};
}

/** Extract only the last assistant's text; never walk nested tool result details. */
function outputOf(record: RunRecord | RunResult): { text: string; bytes: number; truncated: boolean } {
	const published = record as RunResult;
	if (published.output !== undefined || published.outputBytes !== undefined || published.outputTruncated) {
		const text = published.output ?? "";
		return { text, bytes: published.outputBytes ?? Buffer.byteLength(text), truncated: !!published.outputTruncated };
	}
	const raw = record as RunRecord;
	let text = "";
	if (raw.messages) {
		for (let i = raw.messages.length - 1; i >= 0; i--) {
			const message = raw.messages[i];
			if (message.role !== "assistant") continue;
			text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			break;
		}
	}
	// JSON is already validated by the runner. Do not copy/stringify parsedOutput:
	// it can duplicate a huge document, or contain legacy recursive tool details.
	if (!text && record.status !== "ok") text = record.errorMessage || raw.stderr || "";
	return { text, bytes: Buffer.byteLength(text), truncated: false };
}

/** Make a compact DTO without mutating a live run or eagerly loading any artifact. */
export function compactRun(record: RunRecord | RunResult): RunResult {
	let omitted = !!(record as RunResult).metadataTruncated;
	const label = (value: string | undefined, bytes = MAX_RUN_METADATA_BYTES): string | undefined => {
		if (value === undefined) return undefined;
		const clipped = preview(value, bytes, 20);
		omitted ||= clipped.truncated;
		return clipped.text;
	};
	const ref = (value: string | undefined): string | undefined => {
		if (value === undefined || Buffer.byteLength(value) <= PATH_BYTES) return value;
		omitted = true;
		return undefined; // A clipped path would point at a different, nonexistent artifact.
	};
	const result: RunResult = {
		id: record.id,
		agent: label(record.agent, LABEL_BYTES)!,
		agentSource: record.agentSource,
		status: record.status,
		attempts: record.attempts,
		startedAt: record.startedAt,
		usage: copyUsage(record.usage),
	};
	// These identities are exact, not labels or previews. Never shorten/drop them.
	for (const key of ["treeId", "parentRunId", "resumeOf"] as const)
		if (record[key] !== undefined) result[key] = record[key];
	for (const key of ["step", "endedAt", "exitCode"] as const)
		if (record[key] !== undefined) result[key] = record[key];
	for (const key of ["task", "model", "stopReason", "errorMessage"] as const) {
		const value = label(record[key]);
		if (value !== undefined) result[key] = value;
	}
	for (const key of ["cwd", "sessionFile"] as const) {
		const value = ref(record[key]);
		if (value !== undefined) result[key] = value;
	}
	if (record.worktree) {
		const source = record.worktree;
		const checkout = ref(source.path);
		const repoRoot = ref(source.repoRoot);
		const branch = ref(source.branch);
		if (checkout && repoRoot && branch) {
			const worktree: WorktreeInfo = { path: checkout, repoRoot, branch };
			for (const key of ["baseCommit", "subdirectory"] as const) {
				const value = ref(source[key]);
				if (value !== undefined) worktree[key] = value;
			}
			result.worktree = worktree;
		}
	}
	if (record.artifacts) {
		const source: RunResultArtifacts = record.artifacts;
		const artifacts: RunResultArtifacts = {};
		for (const key of ["manifest", "patch", "output", "baseCommit"] as const) {
			const value = ref(source[key]);
			if (value !== undefined) artifacts[key] = value;
		}
		artifacts.changedFileCount = source.changedFileCount ?? source.changedFiles?.length ?? 0;
		artifacts.commandCount = source.commandCount ?? source.verification?.length ?? 0;
		if (source.changedFiles) artifacts.changedFiles = source.changedFiles.slice(0, MAX_ARTIFACT_ITEMS)
			.map((file) => ref(file)).filter((file): file is string => file !== undefined);
		if (source.verification) artifacts.verification = source.verification.slice(-2).map((entry) => ({
			command: label(entry.command, 256)!, exitCode: entry.exitCode, isError: entry.isError,
		}));
		omitted ||= artifacts.changedFileCount > (artifacts.changedFiles?.length ?? 0) || artifacts.commandCount > (artifacts.verification?.length ?? 0) ||
			(source.verification ?? []).some((entry) => "output" in entry);
		result.artifacts = artifacts;
	}
	const output = outputOf(record);
	if (output.text || output.bytes || output.truncated) {
		const clipped = preview(output.text, MAX_RUN_OUTPUT_BYTES, MAX_RUN_OUTPUT_LINES);
		if (output.text) result.output = clipped.text;
		result.outputBytes = output.bytes;
		if (clipped.truncated || output.truncated) result.outputTruncated = true;
	}
	if (omitted) result.metadataTruncated = true;
	return result;
}

/** Shrink optional material fairly across runs, never the provenance/accounting core. */
function smallerRun(run: RunResult, outputBytes: number, metadataBytes: number): RunResult {
	const result = { ...run };
	if (result.output && Buffer.byteLength(result.output) > outputBytes) {
		if (outputBytes) result.output = preview(result.output, outputBytes, MAX_RUN_OUTPUT_LINES).text;
		else delete result.output;
		result.outputTruncated = true;
	}
	if (metadataBytes < MAX_RUN_METADATA_BYTES) {
		for (const key of ["task", "model", "stopReason", "errorMessage"] as const) {
			const value = result[key];
			if (value !== undefined && Buffer.byteLength(value) > metadataBytes) {
				if (metadataBytes) result[key] = preview(value, metadataBytes, 8).text;
				else delete result[key];
				result.metadataTruncated = true;
			}
		}
		if (result.artifacts) {
			const { changedFiles: _files, verification: _verification, ...refs } = result.artifacts;
			result.artifacts = refs;
			result.metadataTruncated = true;
		}
		if (!metadataBytes) {
			for (const key of ["cwd", "sessionFile", "worktree", "artifacts"] as const) {
				if (result[key] !== undefined) result.metadataTruncated = true;
				delete result[key];
			}
		}
	}
	return result;
}

/** Sanitize both new details and legacy task snapshots containing full RunRecords. */
export function compactDetails(details: SubagentDetails): SubagentDetails {
	const result: SubagentDetails = {
		mode: details.mode,
		agentScope: preview(details.agentScope ?? "user", 256, 8).text,
		projectAgentsDir: details.projectAgentsDir && Buffer.byteLength(details.projectAgentsDir) <= PATH_BYTES
			? details.projectAgentsDir : null,
		results: details.results.map(compactRun),
	};
	if (details.status !== undefined) result.status = details.status;
	if (details.taskId !== undefined) result.taskId = details.taskId;
	if (details.notify !== undefined) result.notify = details.notify;
	if (details.errorMessage !== undefined) result.errorMessage = preview(details.errorMessage, MAX_RUN_METADATA_BYTES, 20).text;
	if (details.truncated || result.projectAgentsDir !== details.projectAgentsDir || result.agentScope !== details.agentScope ||
		result.errorMessage !== details.errorMessage || result.results.some((r) => r.outputTruncated || r.metadataTruncated))
		result.truncated = true;
	for (const [outputBytes, metadataBytes] of [[2048, 1024], [1024, 512], [512, 256], [256, 256], [0, 256], [0, 0]]) {
		if (jsonBytes(result) <= MAX_RESULT_DETAILS_BYTES) return result;
		result.results = result.results.map((run) => smallerRun(run, outputBytes, metadataBytes));
		result.truncated = true;
	}
	if (jsonBytes(result) > MAX_RESULT_DETAILS_BYTES)
		throw new RangeError("Run identities and usage exceed the result budget; request a smaller page");
	return result;
}

interface DetailLimits { stringBytes: number; items: number; depth: number; metadataBytes: number }
interface Sanitation { truncated: boolean; seen: Set<object> }
const TRANSCRIPT_KEYS = new Set(["messages", "attemptHistory", "parsedOutput", "outputSchema", "stderr"]);
const IDENTITY_KEYS = new Set(["id", "runId", "treeId", "parentRunId", "resumeOf", "taskId"]);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"] as const;

function object(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isRun(value: Record<string, any>): value is RunResult & Record<string, any> {
	return typeof value.id === "string" && typeof value.agent === "string" && typeof value.status === "string" && object(value.usage);
}

/** Generic tool details can contain task/result wrappers as well as SubagentDetails. */
function sanitize(value: unknown, limits: DetailLimits, state: Sanitation, depth = 0, key = ""): unknown {
	if (typeof value === "string") {
		if (IDENTITY_KEYS.has(key)) return value;
		if (Buffer.byteLength(value) <= limits.stringBytes) return value;
		state.truncated = true;
		return limits.stringBytes ? preview(value, limits.stringBytes, MAX_RESULT_TEXT_LINES).text : OMITTED;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
	if (typeof value !== "object") { state.truncated = true; return OMITTED; }
	if (state.seen.has(value)) { state.truncated = true; return "[Circular reference omitted]"; }
	state.seen.add(value);
	try {
		// Legacy provenance-only entries may lack a run's display/status fields.
		// Their accounting still must not be pruned with generic object fields.
		if (key === "usage" && object(value) && USAGE_FIELDS.every((field) => typeof value[field] === "number"))
			return copyUsage(value as UsageStats);
		if (object(value) && isRun(value)) {
			const run = smallerRun(compactRun(value), Math.min(MAX_RUN_OUTPUT_BYTES, limits.stringBytes), limits.metadataBytes);
			state.truncated ||= !!run.outputTruncated || !!run.metadataTruncated;
			return run;
		}
		if (object(value) && Array.isArray(value.results) && ["single", "parallel", "chain", "background"].includes(value.mode)) {
			const details = compactDetails(value as SubagentDetails);
			details.results = details.results.map((run) => smallerRun(run, Math.min(MAX_RUN_OUTPUT_BYTES, limits.stringBytes), limits.metadataBytes));
			state.truncated ||= !!details.truncated || details.results.some((r) => r.outputTruncated || r.metadataTruncated);
			return details;
		}
		if (depth >= limits.depth) { state.truncated = true; return "[Nested details omitted]"; }
		if (Array.isArray(value)) {
			// Direct run results carry accounting provenance; never silently drop them.
			const keepAll = key === "results";
			const items = keepAll ? value : value.slice(0, limits.items);
			state.truncated ||= items.length !== value.length;
			return items.map((item) => sanitize(item, limits, state, depth + 1));
		}
		const result: Record<string, unknown> = {};
		let count = 0;
		for (const field of Object.keys(value)) {
			if (TRANSCRIPT_KEYS.has(field)) { state.truncated = true; continue; }
			if (count++ >= limits.items && !IDENTITY_KEYS.has(field) && field !== "usage" && field !== "results") {
				state.truncated = true; continue;
			}
			const fieldName = truncateToBytes(field, 128).text;
			state.truncated ||= fieldName !== field;
			if (Object.hasOwn(result, fieldName)) { state.truncated = true; continue; }
			Object.defineProperty(result, fieldName, { value: sanitize((value as Record<string, unknown>)[field], limits, state, depth + 1, field), enumerable: true });
		}
		return result;
	} finally { state.seen.delete(value); }
}

/**
 * Bound the *serialized whole result*, including escaped JSON details and usage.
 * T keeps each tool's public details type; optional previews/lists may be omitted.
 * Nontruncatable provenance exceeding the budget fails explicitly rather than
 * publishing incorrect run IDs or losing usage. Normal plans contain <=32 runs.
 */
export function boundedResult<T>(text: string, details: T, usage?: Usage): AgentToolResult<T> {
	let safeDetails: unknown;
	let detailsTruncated = false;
	for (const limits of [
		{ stringBytes: 8192, items: 64, depth: 12, metadataBytes: MAX_RUN_METADATA_BYTES },
		{ stringBytes: 2048, items: 32, depth: 10, metadataBytes: 256 },
		{ stringBytes: 512, items: 16, depth: 8, metadataBytes: 256 },
		{ stringBytes: 256, items: 8, depth: 6, metadataBytes: 0 },
		{ stringBytes: 0, items: 4, depth: 4, metadataBytes: 0 },
	]) {
		const state: Sanitation = { truncated: false, seen: new Set() };
		safeDetails = sanitize(details, limits, state);
		detailsTruncated = state.truncated;
		if (jsonBytes(safeDetails) <= MAX_RESULT_DETAILS_BYTES) break;
	}
	if (jsonBytes(safeDetails) > MAX_RESULT_DETAILS_BYTES)
		throw new RangeError("Result details exceed the budget even without previews; request a smaller page");
	const make = (maxBytes: number): AgentToolResult<T> => ({
		content: [{ type: "text", text: preview(text, maxBytes, MAX_RESULT_TEXT_LINES, detailsTruncated).text }],
		details: safeDetails as T,
		...(usage === undefined ? {} : { usage }),
	});
	let result = make(MAX_RESULT_TEXT_BYTES);
	if (jsonBytes(result) <= MAX_RESULT_BYTES) return result;
	// JSON escaping can make a <=32KiB string occupy much more than 32KiB.
	// Binary search the actual envelope instead of assuming a byte ratio.
	let low = Buffer.byteLength(`\n\n${RESULT_TRUNCATION_NOTICE}`);
	let high = MAX_RESULT_TEXT_BYTES;
	result = make(low);
	if (jsonBytes(result) > MAX_RESULT_BYTES) throw new RangeError("SDK usage and run identities exceed the result budget");
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = make(middle);
		if (jsonBytes(candidate) <= MAX_RESULT_BYTES) { result = candidate; low = middle; }
		else high = middle - 1;
	}
	return result;
}
