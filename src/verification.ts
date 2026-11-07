/** Attempt-scoped shell evidence. Nested execution events are not transcript entries. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { truncateToBytes } from "./format.ts";
import type { RunStatus, VerificationEvidence } from "./types.ts";

const EXCERPT_BYTES = 8192;
type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const keyFor = (id: string, parent?: string) => JSON.stringify([parent ?? null, id]);
const code = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

/** Ignore accounting annotations added only to RPC messages when matching copied history. */
function messageKey(value: ObjectValue): string {
	return hash(JSON.stringify([value.role, value.timestamp, value.content, value.toolCallId, value.toolName]));
}
function textOf(result: ObjectValue): string {
	return Array.isArray(result.content)
		? result.content.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text).join("\n")
		: "";
}

export interface VerificationOptions {
	runId: string;
	attempt: number;
	artifactDir: string;
	cwd: string;
	/** Existing evidence can be rehydrated after a dispatcher restart without duplicating calls. */
	evidence?: VerificationEvidence[];
	/** Copied session entries belong to the source run, not this continuation. */
	historicalMessages?: unknown[];
}

/** Never consult nestedCalls: it is bounded, lacks results, and may omit arbitrary depths. */
export class VerificationCollector {
	readonly evidence: VerificationEvidence[];
	private calls = new Map<string, VerificationEvidence>();
	private historical: Set<string>;
	private eventResults = new Set<string>();
	private transcriptResults = new Set<string>();
	private options: VerificationOptions;

	constructor(options: VerificationOptions) {
		this.options = options;
		this.evidence = options.evidence ?? [];
		this.historical = new Set((options.historicalMessages ?? []).map((message) => messageKey(object(message))));
		for (const entry of this.evidence) {
			if (!entry.toolCallId || entry.runId !== options.runId || entry.attempt !== options.attempt) continue;
			const key = keyFor(entry.toolCallId, entry.parentToolCallId);
			this.calls.set(key, entry);
			if (entry.endObserved) this.eventResults.add(key);
			if (entry.resultObserved) this.transcriptResults.add(key);
		}
	}

	private call(id: string, parent: string | undefined, source: "event" | "transcript"): VerificationEvidence {
		const key = keyFor(id, parent);
		let entry = this.calls.get(key);
		if (!entry) {
			entry = { runId: this.options.runId, attempt: this.options.attempt, toolCallId: id,
				...(parent === undefined ? {} : { parentToolCallId: parent }), command: "", outcome: "incomplete", source,
				startObserved: false, endObserved: false, output: "" };
			this.calls.set(key, entry);
			this.evidence.push(entry);
		} else if (entry.source !== source) entry.source = "event+transcript";
		return entry;
	}

	/** Returns whether a shell observation needs a progress checkpoint. */
	observeEvent(value: unknown): boolean {
		const event = object(value);
		if (event.toolName !== "bash" || typeof event.toolCallId !== "string" ||
			!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) return false;
		const parent = typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined;
		const key = keyFor(event.toolCallId, parent);
		const entry = this.call(event.toolCallId, parent, "event");
		if (typeof event.args?.command === "string") entry.command = event.args.command;
		if (event.type === "tool_execution_start") {
			entry.startObserved = true;
		} else if (event.type === "tool_execution_end") {
			if (this.eventResults.has(key)) return false;
			this.eventResults.add(key);
			if (!entry.endObserved && !entry.resultObserved) entry.outcome = "incomplete";
			entry.endObserved = true;
			this.result(entry, object(event.result), event.isError, true);
		} else if (!this.eventResults.has(key) && !this.transcriptResults.has(key)) {
			this.output(entry, object(event.partialResult), false);
		}
		return true;
	}

	observeMessage(value: unknown): void {
		const message = object(value);
		if (this.historical.has(messageKey(message))) return;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part?.type !== "toolCall" || part.name !== "bash" || typeof part.id !== "string") continue;
				const entry = this.call(part.id, undefined, "transcript");
				if (!entry.command && typeof part.arguments?.command === "string") entry.command = part.arguments.command;
			}
		} else if (message.role === "toolResult" && message.toolName === "bash" && typeof message.toolCallId === "string") {
			const key = keyFor(message.toolCallId);
			const entry = this.call(message.toolCallId, undefined, "transcript");
			if (this.transcriptResults.has(key)) return;
			this.transcriptResults.add(key);
			if (!entry.endObserved && !entry.resultObserved) entry.outcome = "incomplete";
			entry.resultObserved = true;
			this.result(entry, message, message.isError, !this.eventResults.has(key));
		}
	}

	private result(entry: VerificationEvidence, result: ObjectValue, isError: unknown, preferOutput: boolean): void {
		const details = object(result.details);
		const structured = object(result.structuredContent);
		const exitCode = code(structured.exit_code) ?? code(details.exitCode) ?? code(result.exitCode) ?? code(result.exit_code);
		// Enrich a lost/older RPC end from the transcript, but never invent code zero.
		if (exitCode !== undefined && (preferOutput || entry.exitCode === undefined)) entry.exitCode = exitCode;
		const text = textOf(result);
		const cancelled = [result, details, structured].some((value) => value.cancelled === true || value.aborted === true) ||
			(isError === true && /(?:^|\n\n)Command aborted$/.test(text));
		if (cancelled) entry.outcome = "cancelled";
		else if (isError === true || result.isError === true || (entry.exitCode !== undefined && entry.exitCode !== 0)) {
			if (entry.outcome !== "cancelled") entry.outcome = "error";
		} else if (entry.outcome !== "cancelled" && entry.outcome !== "error") entry.outcome = "completed";
		if (typeof isError === "boolean") entry.isError = entry.isError === true || isError;
		if (preferOutput || (!entry.output && !entry.fullOutputPath)) this.output(entry, result, true);
	}

	private output(entry: VerificationEvidence, result: ObjectValue, terminal: boolean): void {
		const structured = object(result.structuredContent);
		const details = object(result.details);
		// Structured bash output is often larger than model-facing content (50 KiB).
		const structuredText = typeof structured.output === "string";
		const text = structuredText ? structured.output as string : textOf(result);
		const excerpt = truncateToBytes(text, EXCERPT_BYTES);
		const upstreamTruncated = structuredText ? structured.truncated === true :
			details.truncation?.truncated === true || result.truncated === true;
		const reportedSource = details.fullOutputPath ?? structured.full_output_path ?? result.fullOutputPath;
		const previousSource = entry.fullOutputSourcePath;
		const freshSource = typeof reportedSource === "string" ? path.resolve(this.options.cwd, reportedSource) : undefined;
		// SDK cancellation ends may be nothing but a tail plus "Command aborted".
		// Missing details cannot retract a preceding truncation/source observation.
		const inheritedTail = entry.outputTruncated === true && !structuredText && freshSource === undefined;
		entry.output = excerpt.text;
		entry.outputTruncated = excerpt.truncated || upstreamTruncated || inheritedTail;
		if (freshSource !== undefined) entry.fullOutputSourcePath = freshSource;
		const fullText = structuredText && !upstreamTruncated;
		const source = freshSource ?? (fullText ? undefined : entry.fullOutputSourcePath);
		if (!entry.outputTruncated && source === undefined) return;
		// Preserve the first stable copy promptly, but do not copy a growing file on
		// every progress notification. Terminal/finish refreshes capture its final bytes.
		if (!terminal && source !== undefined && source === previousSource && entry.fullOutputPath && !entry.outputError) return;
		const completed = terminal && entry.outcome !== "cancelled";
		this.captureOutput(entry, text, source, completed && freshSource !== undefined,
			completed && !upstreamTruncated && !inheritedTail, upstreamTruncated || inheritedTail);
	}

	/** Artifact I/O is observational: a failure must never poison transcript or usage recovery. */
	private captureOutput(entry: VerificationEvidence, text: string, source: string | undefined,
		sourceComplete: boolean, textComplete: boolean, preserveArtifact: boolean): void {
		const target = path.join(this.options.artifactDir,
			`${this.options.runId}-${this.options.attempt}-bash-${hash(keyFor(entry.toolCallId!, entry.parentToolCallId))}.txt`);
		const temp = `${target}.${randomUUID()}.tmp`;
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			let copied = false, sourceFailed = false;
			if (source !== undefined) {
				try {
					if (!fs.statSync(source).isFile()) throw new Error("Not a regular output file");
					fs.copyFileSync(source, temp);
					fs.chmodSync(temp, 0o600);
					copied = true;
				} catch (err) {
					sourceFailed = true;
					entry.outputError = `Full output unavailable: ${String(err)}`;
				}
			}
			if (!copied) {
				// Never replace an earlier full/partial copy with a newly truncated tail,
				// including when the child's original file disappeared during shutdown.
				if (entry.fullOutputPath && (preserveArtifact || sourceFailed)) return;
				fs.writeFileSync(temp, text, { mode: 0o600 });
			}
			fs.renameSync(temp, target);
			entry.fullOutputPath = target;
			entry.fullOutputComplete = copied ? sourceComplete : textComplete && !sourceFailed;
			if (copied || (textComplete && !sourceFailed)) delete entry.outputError;
		} catch (err) {
			entry.outputError = `Verification output capture failed: ${String(err)}`;
			entry.fullOutputComplete = false;
		} finally {
			try { fs.rmSync(temp, { force: true }); }
			catch (err) { entry.outputError = `${entry.outputError ? `${entry.outputError}; ` : ""}Output cleanup failed: ${String(err)}`; }
		}
	}

	/** A stopped/vanished worker does not turn an unpaired start into a passing check. */
	finish(status: RunStatus): void {
		for (const entry of this.evidence) {
			if (entry.fullOutputSourcePath && !entry.fullOutputComplete)
				this.captureOutput(entry, entry.output, entry.fullOutputSourcePath, false, false, true);
			if (entry.outcome !== "incomplete") continue;
			if (["aborted", "timeout", "budget", "max-turns"].includes(status)) entry.outcome = "cancelled";
		}
	}
}
