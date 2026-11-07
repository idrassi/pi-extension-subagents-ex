/** Append-only run transcripts, atomic metadata/index checkpoints, and worktree ownership. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type DisplayItem, getDisplayItems, getFinalOutput, truncateToBytes } from "./format.ts";
import { isProcessAlive, readJson, withLock, writeJson } from "./files.ts";
import type { AttemptRecord, RunRecord, RunStatus, WorktreeInfo } from "./types.ts";

export const STATE_DIR = path.join(getAgentDir(), "subagents-ex");
export const RUNS_DIR = path.join(STATE_DIR, "runs");
export const SESSIONS_DIR = path.join(STATE_DIR, "sessions");
export const ARTIFACTS_DIR = path.join(STATE_DIR, "artifacts");
const WORKTREES_DIR = path.join(STATE_DIR, "worktrees");

export interface StoredRun extends RunRecord {
	version: 2;
	ts: number;
	durationMs: number;
	finalOutput: string;
	transcript: DisplayItem[];
}

export interface RunSummary {
	id: string;
	file: string;
	ts: number;
	durationMs: number;
	agent: string;
	status: RunStatus;
	task: string;
	cost: number;
	model?: string;
	cwd: string;
}

export function runFile(id: string): string {
	if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid run id");
	return path.join(RUNS_DIR, `${id}.json`);
}

/** Stable bulk-output reference for result DTOs; it exists once the run settles. */
export function runOutputFile(id: string): string {
	runFile(id); // Share the run-id/path validation with the existing APIs.
	return path.join(RUNS_DIR, `${id}.output.txt`);
}

// The optional verification field is read-only compatibility for older v3 checkpoints.
// New checkpoints strip it; evidence is an incremental, checksummed attempt stream.
type AttemptMetadata = Omit<AttemptRecord, "messages" | "diagnostics" | "stderr" | "verification"> &
	Pick<AttemptRecord, "verification">;
type RecordMetadata = Omit<RunRecord, "messages" | "stderr" | "attemptHistory" | "parsedOutput" | "artifacts" | "task" | "outputSchema">;
interface CheckpointData {
	record: RecordMetadata;
	taskFile: string;
	attemptHistory?: AttemptMetadata[];
	messageStream: string;
	stderrStream: string;
	ts: number;
	durationMs: number;
}
interface JournalPosition {
	file: string;
	bytes: number;
	sequence: number;
	hash: string;
}
interface Checkpoint extends CheckpointData {
	version: 3;
	journal: JournalPosition;
	/** Derived output is independently replaceable; a stale file is never served. */
	outputStamp?: string;
	/** This per-run index is committed atomically with the metadata it describes. */
	summary: RunSummary;
}
interface Stream {
	messages: RunRecord["messages"];
	diagnostics: string[];
	stderr: string;
	/** Absent and explicitly empty legacy evidence remain distinct. */
	verification?: AttemptRecord["verification"];
}
interface StreamChange {
	stream: string;
	messages?: { offset: number; values: RunRecord["messages"] };
	diagnostics?: { offset: number; values: string[] };
	stderr?: { offset: number; value: string };
	/** Null removes the optional evidence field; [] is still an observed empty stream. */
	verification?: { length: number; updates: { index: number; value: NonNullable<AttemptRecord["verification"]>[number] }[] } | null;
}
type ValueKey = "parsedOutput" | "artifacts" | "outputSchema";
interface ValueChange {
	key: ValueKey;
	value?: unknown;
}
interface Transaction {
	sequence: number;
	previous: string;
	changes: StreamChange[];
	values: ValueChange[];
	checkpoint: CheckpointData;
}
interface WriterState {
	position: JournalPosition;
	checkpoint: CheckpointData;
	streams: Map<string, Stream>;
	values: Partial<Record<ValueKey, unknown>>;
	stamp?: string;
}
const writers = new WeakMap<RunRecord, WriterState>();
const INTERRUPTED = "Dispatcher stopped before the run settled; resume the saved child session explicitly.";
const emptyStream = (): Stream => ({ messages: [], diagnostics: [], stderr: "" });

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function statStamp(stat: fs.BigIntStats): string {
	return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function stamp(file: string): string {
	return statStamp(fs.statSync(file, { bigint: true }));
}
function matchesStamp(file: string, expected: string | undefined): boolean {
	if (expected === undefined) return false;
	try { return stamp(file) === expected; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
}
function journalPath(id: string, name: string): string {
	if (!name.startsWith(`${id}.`) || !/^run-[a-zA-Z0-9-]+\.[a-f0-9-]+\.jsonl$/.test(name))
		throw new Error("Invalid run journal path");
	return path.join(RUNS_DIR, name);
}
function isCheckpoint(value: unknown): value is Checkpoint {
	return !!value && (value as Checkpoint).version === 3;
}
function validateCheckpoint(data: CheckpointData, id: string): void {
	if (
		data.record?.id !== id || !Number.isFinite(data.ts) || !Number.isFinite(data.durationMs) ||
		!validTaskFile(id, data.taskFile) ||
		!validStream(data.messageStream) || !validStream(data.stderrStream) ||
		(data.attemptHistory !== undefined && !Array.isArray(data.attemptHistory))
	) throw new Error("Invalid run checkpoint");
}
function validateCommittedCheckpoint(disk: Checkpoint, id: string): void {
	validateCheckpoint(disk, id);
	if (disk.summary?.id !== id) throw new Error("Invalid run checkpoint summary");
	const position = disk.journal;
	if (!position || !Number.isSafeInteger(position.bytes) || position.bytes <= 0 ||
		!Number.isSafeInteger(position.sequence) || position.sequence <= 0 || !/^[a-f0-9]{64}$/.test(position.hash))
		throw new Error("Invalid journal checkpoint");
	journalPath(id, position.file);
}
function validStream(name: string): boolean {
	return typeof name === "string" && /^(run|attempt-\d+)$/.test(name);
}
function interrupted(record: Pick<RunRecord, "endedAt" | "ownerPid" | "childPid">): boolean {
	return !!(!record.endedAt && record.ownerPid && !isProcessAlive(record.ownerPid) &&
		(!record.childPid || !isProcessAlive(record.childPid)));
}
function classify(run: StoredRun): StoredRun {
	if (interrupted(run)) {
		run.status = "interrupted";
		run.endedAt = run.startedAt + run.durationMs;
		run.errorMessage = INTERRUPTED;
		const attempt = run.attemptHistory?.at(-1);
		if (attempt && !attempt.endedAt) {
			attempt.status = "interrupted";
			attempt.endedAt = run.endedAt;
			attempt.errorMessage = INTERRUPTED;
		}
	}
	return run;
}
function summary(data: Pick<CheckpointData, "record" | "ts" | "durationMs">, file: string, task: string): RunSummary {
	const r = data.record;
	return {
		id: r.id, file, ts: data.ts, durationMs: data.durationMs, agent: r.agent,
		task: truncateToBytes(task, 512).text,
		status: r.status, cost: r.usage?.cost ?? 0,
		model: r.model, cwd: r.cwd,
	};
}

/** Linux requires directory fsync: a failed durability barrier fails the operation.
 * On other platforms, unsupported directory syncing falls back to atomic rename /
 * process-crash safety only; power-loss durability is not guaranteed there. */
function syncDirectory(directory: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(directory, "r");
		fs.fsyncSync(fd);
	} catch (error) {
		if (process.platform === "linux" || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES", "EBADF", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	} finally { if (fd !== undefined) fs.closeSync(fd); }
}
function ensureDirectory(directory: string): void {
	const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (created === undefined) return;
	// Persist newly created ancestors too, including the entry for RUNS_DIR itself.
	for (let current = directory;; current = path.dirname(current)) {
		syncDirectory(current);
		if (current === path.dirname(created)) break;
	}
}
/** Synchronous to preserve saveRun's API. Pruning never waits on another writer. */
function lockRun(file: string): () => void {
	ensureDirectory(path.dirname(file));
	return lockfile.lockSync(file, { realpath: false, stale: 60_000 });
}
function writeText(file: string, text: string | Buffer): void {
	ensureDirectory(path.dirname(file));
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		const fd = fs.openSync(temporary, "wx", 0o600);
		try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(temporary, file);
		syncDirectory(path.dirname(file));
	} finally { fs.rmSync(temporary, { force: true }); }
}
function writeCheckpoint(file: string, checkpoint: Checkpoint): void {
	writeText(file, JSON.stringify(checkpoint, null, 2));
}
function removeOutput(id: string): void {
	try { fs.unlinkSync(runOutputFile(id)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	syncDirectory(RUNS_DIR);
}
function backupLegacy(file: string): void {
	const original = fs.readFileSync(file);
	const backup = `${file}.v2-backup`;
	let complete = false;
	try { complete = fs.readFileSync(backup).equals(original); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (!complete) writeText(backup, original); // Replace partial leftovers atomically, never copy over them in place.
	const fd = fs.openSync(backup, "r");
	try {
		if (!fs.readFileSync(fd).equals(original)) throw new Error("Legacy backup verification failed");
		fs.fsyncSync(fd);
	} finally { fs.closeSync(fd); }
	syncDirectory(path.dirname(backup));
}
function validTaskFile(id: string, name: string): boolean {
	return typeof name === "string" && name.startsWith(`${id}.`) && /^run-[a-zA-Z0-9-]+\.[a-f0-9]{64}\.task.txt$/.test(name);
}
function readTask(data: CheckpointData): string {
	if (!validTaskFile(data.record.id, data.taskFile)) throw new Error("Invalid task metadata path");
	const text = fs.readFileSync(path.join(RUNS_DIR, data.taskFile), "utf8");
	if (data.taskFile !== `${data.record.id}.${hash(text)}.task.txt`) throw new Error("Corrupt task metadata");
	return text;
}

function applyChange(streams: Map<string, Stream>, change: StreamChange): void {
	if (!validStream(change.stream)) throw new Error("Invalid transcript stream");
	const stream = streams.get(change.stream) ?? emptyStream();
	if (change.verification === null) delete stream.verification;
	else if (change.verification !== undefined) {
		const { length, updates } = change.verification;
		const target = stream.verification ?? [];
		if (!Number.isSafeInteger(length) || length < 0 || !Array.isArray(updates)) throw new Error("Invalid verification patch");
		let previous = -1, appended = target.length;
		for (const update of updates) {
			if (!update || !Number.isSafeInteger(update.index) || update.index <= previous || update.index >= length)
				throw new Error("Invalid verification index");
			if (update.index >= target.length && update.index !== appended++) throw new Error("Missing verification append");
			previous = update.index;
		}
		if (length > target.length && appended !== length) throw new Error("Missing verification append");
		target.length = length;
		for (const { index, value } of updates) target[index] = value;
		stream.verification = target;
	}
	for (const key of ["messages", "diagnostics"] as const) {
		const patch = change[key];
		if (!patch) continue;
		const target: unknown[] = stream[key];
		if (!Number.isSafeInteger(patch.offset) || patch.offset < 0 || patch.offset > target.length ||
			!Array.isArray(patch.values)) throw new Error("Invalid transcript offset");
		if (key === "diagnostics" && !patch.values.every((v) => typeof v === "string")) throw new Error("Invalid diagnostic");
		// These replay arrays are private, validated state. Keep the prefix in place:
		// copying it on every append makes replay quadratic in accumulated elements.
		target.length = patch.offset;
		for (const value of patch.values) target.push(value); // No argument-count limit on large suffixes.
	}
	if (change.stderr) {
		const { offset, value } = change.stderr;
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > stream.stderr.length || typeof value !== "string")
			throw new Error("Invalid stderr offset");
		stream.stderr = stream.stderr.slice(0, offset) + value;
	}
	streams.set(change.stream, stream);
}

/** Only explicit loads/restarts read journals. Complete corrupt lines are never skipped. */
function readJournal(disk: Checkpoint): WriterState {
	const id = disk.record.id;
	validateCommittedCheckpoint(disk, id);
	const position = disk.journal;
	const file = journalPath(id, position.file);
	const raw = fs.readFileSync(file);
	const { version: _version, journal: _journal, summary: _summary, outputStamp: _outputStamp, ...projection } = disk;
	const streams = new Map<string, Stream>();
	const values: WriterState["values"] = {};
	let sequence = 0, previous = "", start = 0;
	let recovered: WriterState | undefined;
	for (;;) {
		const end = raw.indexOf(10, start);
		if (end < 0) break; // An unterminated final write is not a committed JSONL entry.
		const entry = JSON.parse(raw.subarray(start, end).toString("utf8")) as { checksum: string; data: Transaction };
		const tx = entry.data;
		if (!tx || tx.sequence !== sequence + 1 || tx.previous !== previous ||
			hash(JSON.stringify(tx)) !== entry.checksum || !Array.isArray(tx.changes) || !Array.isArray(tx.values))
			throw new Error("Corrupt run journal");
		validateCheckpoint(tx.checkpoint, id);
		sequence = tx.sequence;
		previous = entry.checksum;
		start = end + 1;
		if (sequence > position.sequence) continue; // Valid but uncommitted data; never expose it.
		for (const change of tx.changes) applyChange(streams, change);
		for (const change of tx.values) {
			if (change.key !== "parsedOutput" && change.key !== "artifacts" && change.key !== "outputSchema") throw new Error("Invalid output field");
			if (Object.hasOwn(change, "value")) values[change.key] = change.value;
			else delete values[change.key];
		}
		recovered = {
			position: { file: position.file, bytes: start, sequence, hash: previous },
			checkpoint: tx.checkpoint, streams, values,
		};
		if (sequence === position.sequence && (start !== position.bytes || previous !== position.hash ||
			!isDeepStrictEqual(tx.checkpoint, projection))) throw new Error("Metadata/journal checkpoint mismatch");
	}
	if (!recovered || (sequence < position.sequence && raw.length >= position.bytes))
		throw new Error("Missing committed transcript");
	// If a committed final write was torn, its preceding complete transaction includes
	// the corresponding metadata, so no newer status/attempt count leaks into recovery.
	recovered.stamp = stamp(file);
	return recovered;
}

/** Publish the recovered N-1 metadata durably before a writer can reuse torn slot N.
 * If either publication fails, the visible checkpoint still names an intact prefix.
 * The old output stamp described N, so it must not be carried into recovery. */
function publishRecovery(file: string, disk: Checkpoint, state: WriterState): Checkpoint {
	if (state.position.sequence === disk.journal.sequence && state.position.hash === disk.journal.hash) return disk;
	const recovered: Checkpoint = {
		version: 3, ...state.checkpoint, journal: state.position,
		summary: summary(state.checkpoint, file, readTask(state.checkpoint)),
	};
	writeCheckpoint(file, recovered);
	return recovered;
}

function arrayChange<T>(before: T[], after: T[]): { offset: number; values: T[] } | undefined {
	let offset = 0;
	// Deep comparison (not serialization) also detects in-place edits. Snapshots are
	// detached only for new/changed suffixes, never by cloning the accumulated run.
	while (offset < before.length && offset < after.length && isDeepStrictEqual(before[offset], after[offset])) offset++;
	return offset === before.length && offset === after.length ? undefined : { offset, values: after.slice(offset) };
}
function streamChange(name: string, before: Stream, after: Partial<Stream>): StreamChange | undefined {
	const change: StreamChange = { stream: name };
	if (after.messages) change.messages = arrayChange(before.messages, after.messages);
	if (after.diagnostics) change.diagnostics = arrayChange(before.diagnostics, after.diagnostics);
	if (Object.hasOwn(after, "verification")) {
		if (after.verification === undefined) {
			if (before.verification !== undefined) change.verification = null;
		} else {
			// Unlike messages, an early long-running command can change while later
			// commands append/settle. Persist only changed indexes, never its whole suffix.
			const prior = before.verification ?? [];
			const updates: NonNullable<StreamChange["verification"]>["updates"] = [];
			for (let index = 0; index < after.verification.length; index++) {
				const value = after.verification[index];
				if (index >= prior.length || !Object.is(prior[index], value) && !isDeepStrictEqual(prior[index], value))
					updates.push({ index, value });
			}
			if (updates.length || before.verification === undefined || prior.length !== after.verification.length)
				change.verification = { length: after.verification.length, updates };
		}
	}
	if (after.stderr !== undefined && after.stderr !== before.stderr) {
		const offset = after.stderr.startsWith(before.stderr) ? before.stderr.length : 0;
		change.stderr = { offset, value: after.stderr.slice(offset) };
	}
	return change.messages || change.diagnostics || change.stderr || change.verification !== undefined ? change : undefined;
}
function checkpointData(record: RunRecord): CheckpointData {
	// Strip both transcript fields and derived fields when the input is a loaded StoredRun.
	const { messages, stderr, attemptHistory, parsedOutput: _parsed, artifacts: _artifacts,
		task, outputSchema: _schema, version: _version, ts: _ts, durationMs: _duration, finalOutput: _final, transcript: _transcript,
		...metadata } = record as StoredRun;
	let messageStream = "run", stderrStream = "run";
	for (let i = 0; i < (attemptHistory?.length ?? 0); i++) {
		const attempt = attemptHistory![i];
		if (attempt.messages === messages || isDeepStrictEqual(attempt.messages, messages)) messageStream = `attempt-${i}`;
		if (attempt.stderr === stderr) stderrStream = `attempt-${i}`;
	}
	return {
		record: metadata, taskFile: `${record.id}.${hash(task)}.task.txt`,
		...(attemptHistory === undefined ? {} : { attemptHistory: attemptHistory.map(({ messages: _messages,
			diagnostics: _diagnostics, stderr: _stderr, verification: _verification, ...attempt }) => attempt) }),
		messageStream, stderrStream, ts: record.startedAt,
		durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
	};
}

export function saveRun(record: RunRecord): void {
	const file = runFile(record.id);
	const release = lockRun(file);
	try {
		let disk = readJson<Checkpoint | StoredRun>(file);
		let state = writers.get(record);
		if (!isCheckpoint(disk)) {
			state = undefined;
			// Never destroy the sole legacy snapshot, even if migration or a later prune fails.
			if (disk) {
				if (disk.version !== 2 || disk.id !== record.id) throw new Error("Unsupported existing run snapshot");
				backupLegacy(file);
			}
		} else {
			validateCommittedCheckpoint(disk, record.id);
			if (!state || state.position.hash !== disk.journal.hash || state.position.sequence !== disk.journal.sequence ||
				state.position.file !== disk.journal.file || state.position.bytes !== disk.journal.bytes ||
				state.stamp !== stamp(journalPath(record.id, disk.journal.file))) state = readJournal(disk);
			disk = publishRecovery(file, disk, state);
		}
		if (!state) state = {
			position: { file: `${record.id}.${randomUUID()}.jsonl`, bytes: 0, sequence: 0, hash: "" },
			checkpoint: checkpointData(record), streams: new Map(), values: {},
		};
		const data = checkpointData(record);
		const taskFile = path.join(RUNS_DIR, data.taskFile);
		if (state.checkpoint.taskFile !== data.taskFile || !fs.existsSync(taskFile)) writeText(taskFile, record.task);
		const changes: StreamChange[] = [];
		const add = (name: string, after: Partial<Stream>) => {
			const change = streamChange(name, state!.streams.get(name) ?? emptyStream(), after);
			if (change) changes.push(change);
		};
		for (const [i, attempt] of (record.attemptHistory ?? []).entries()) add(`attempt-${i}`, {
			messages: attempt.messages, diagnostics: attempt.diagnostics, stderr: attempt.stderr, verification: attempt.verification,
		});
		add("run", {
			...(data.messageStream === "run" ? { messages: record.messages } : {}),
			...(data.stderrStream === "run" ? { stderr: record.stderr } : {}),
		});
		const values: ValueChange[] = [];
		for (const key of ["parsedOutput", "artifacts", "outputSchema"] as const) {
			if (!isDeepStrictEqual(state.values[key], record[key]))
				values.push(record[key] === undefined ? { key } : { key, value: record[key] });
		}
		const tx: Transaction = { sequence: state.position.sequence + 1, previous: state.position.hash, changes, values, checkpoint: data };
		const serialized = JSON.stringify(tx);
		const checksum = hash(serialized);
		const line = `{"checksum":"${checksum}","data":${serialized}}\n`;
		const journal = journalPath(record.id, state.position.file);
		const fd = fs.openSync(journal, state.position.sequence === 0 ? "wx" : "r+", 0o600);
		try {
			// Discard only uncommitted/torn tail bytes, never an interior corrupt entry.
			fs.ftruncateSync(fd, state.position.bytes);
			const bytes = Buffer.from(line);
			let written = 0;
			while (written < bytes.length) {
				const count = fs.writeSync(fd, bytes, written, bytes.length - written, state.position.bytes + written);
				if (count <= 0) throw new Error("Incomplete run journal write");
				written += count;
			}
			fs.fsyncSync(fd); // A metadata rename must not advertise transcript bytes not yet durable.
		} finally { fs.closeSync(fd); }
		if (state.position.sequence === 0) syncDirectory(RUNS_DIR); // Publish the new journal dependency before the checkpoint.
		const position = { file: state.position.file, bytes: state.position.bytes + Buffer.byteLength(line), sequence: tx.sequence, hash: checksum };
		// Reuse only the committed materialization of the same selected stream. A
		// failed prior save may already have replaced the output without committing it.
		if (record.endedAt && (!isCheckpoint(disk) || !state.checkpoint.record.endedAt ||
			state.checkpoint.messageStream !== data.messageStream || !matchesStamp(runOutputFile(record.id), disk.outputStamp) ||
			changes.some((c) => c.stream === data.messageStream && c.messages) || values.some((v) => v.key === "parsedOutput")))
			writeText(runOutputFile(record.id), outputText(record));
		writeCheckpoint(file, { version: 3, ...data, journal: position, summary: summary(data, file, record.task),
			...(record.endedAt ? { outputStamp: stamp(runOutputFile(record.id)) } : {}) });
		// Advance the in-memory cursor only after the checkpoint has been committed.
		for (const change of changes) applyChange(state.streams, structuredClone(change));
		for (const change of values) {
			if (Object.hasOwn(change, "value")) state.values[change.key] = structuredClone(change.value);
			else delete state.values[change.key];
		}
		state.position = position;
		state.checkpoint = structuredClone(data);
		state.stamp = stamp(journal);
		writers.set(record, state);
		if (!record.endedAt) removeOutput(record.id); // The unpublication checkpoint is durable before deleting its old output.
	} finally { release(); }
	if (record.endedAt) pruneRuns(record.id);
}

interface LegacyIndex {
	stamp: string;
	summary: RunSummary;
	ownerPid?: number;
	childPid?: number;
	endedAt?: number;
}
const legacyFields = new Set(["id", "version", "ts", "durationMs", "startedAt", "agent", "status", "task", "usage", "model", "cwd", "ownerPid", "childPid", "endedAt"]);
/** Legacy v2 embeds everything in one file. Project top-level metadata without ever
 * JSON-parsing its messages/attempts/derived transcript; cache this one-time scan. */
function legacyProjection(file: string): StoredRun {
	const text = fs.readFileSync(file, "utf8");
	const result: Record<string, unknown> = {};
	let i = 0;
	const whitespace = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
	const valueEnd = () => {
		const start = i;
		let depth = 0, quoted = false, escaped = false;
		for (; i < text.length; i++) {
			const ch = text[i];
			if (quoted) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') quoted = false;
			} else if (ch === '"') quoted = true;
			else if (ch === "[" || ch === "{") depth++;
			else if ((ch === "," || ch === "}") && depth === 0) break;
			else if (ch === "]" || ch === "}") depth--;
		}
		if (quoted || depth !== 0 || i === text.length) throw new Error("Invalid legacy snapshot");
		return text.slice(start, i);
	};
	whitespace();
	if (text[i++] !== "{") throw new Error("Invalid legacy snapshot");
	for (;;) {
		whitespace();
		if (text[i] === "}") break;
		const start = i++;
		if (text[start] !== '"') throw new Error("Invalid legacy key");
		while (i < text.length) {
			if (text[i++] === "\\") i++;
			else if (text[i - 1] === '"') break;
		}
		const key = JSON.parse(text.slice(start, i)) as string;
		whitespace();
		if (text[i++] !== ":") throw new Error("Invalid legacy field");
		const raw = valueEnd();
		if (legacyFields.has(key)) result[key] = JSON.parse(raw);
		if (text[i] === "}") break;
		i++;
	}
	if (result.version !== 2 || typeof result.id !== "string") throw new Error("Unsupported run snapshot");
	return result as unknown as StoredRun;
}
function legacyIndex(file: string): LegacyIndex {
	const indexFile = path.join(RUNS_DIR, "index", path.basename(file));
	const currentStamp = stamp(file);
	try {
		const index = readJson<LegacyIndex>(indexFile);
		if (index?.stamp === currentStamp) return index;
	} catch { /* Rebuild a damaged disposable legacy index. */ }
	const run = legacyProjection(file);
	const index: LegacyIndex = {
		stamp: currentStamp,
		summary: summary({ record: run, ts: run.ts ?? run.startedAt, durationMs: run.durationMs }, file, run.task),
		ownerPid: run.ownerPid, childPid: run.childPid, endedAt: run.endedAt,
	};
	// Cache the persisted status, not the transient liveness classification.
	index.summary.status = run.status;
	if (stamp(file) === currentStamp) writeJson(indexFile, index);
	return index;
}
interface HistoryEntry { run: RunSummary; revision?: string }
/** Peek only at the format header, never deserialize a v2 transcript just to list/page it. */
function hasCheckpointHeader(file: string): boolean {
	const fd = fs.openSync(file, "r");
	const prefix = Buffer.alloc(128);
	let size: number;
	try { size = fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
	return /^\s*\{\s*"version"\s*:\s*3\s*,/.test(prefix.subarray(0, size).toString("utf8"));
}
function history(): HistoryEntry[] {
	let names: string[];
	try { names = fs.readdirSync(RUNS_DIR); } catch { return []; }
	const entries: HistoryEntry[] = [];
	for (const name of names) {
		if (!/^run-[a-zA-Z0-9-]+\.json$/.test(name)) continue;
		const file = path.join(RUNS_DIR, name);
		try {
			if (hasCheckpointHeader(file)) {
				const disk = readJson<Checkpoint>(file);
				if (!isCheckpoint(disk) || runFile(disk.record.id) !== file) continue;
				validateCommittedCheckpoint(disk, disk.record.id);
				entries.push({ run: { ...disk.summary, id: disk.record.id, task: disk.summary.task ?? "", file, status: interrupted(disk.record) ? "interrupted" : disk.record.status },
					revision: disk.journal.hash });
			} else {
				const index = legacyIndex(file);
				if (runFile(index.summary.id) !== file) continue;
				entries.push({ run: { ...index.summary, file, status: interrupted(index) ? "interrupted" : index.summary.status } });
			}
		} catch { /* A corrupt/concurrently pruned run must not hide other metadata. */ }
	}
	return entries.sort((a, b) => b.run.ts - a.run.ts || (a.run.id < b.run.id ? 1 : a.run.id > b.run.id ? -1 : 0));
}

export interface ListRunsPageOptions { cursor?: string; limit?: number }
export interface RunsPage { runs: RunSummary[]; nextCursor?: string }
/** Descending timestamp, then descending id; the opaque cursor survives inserts/deletes. */
export function listRunsPage({ cursor, limit = 30 }: ListRunsPageOptions = {}): RunsPage {
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("History limit must be an integer from 1 to 50");
	let after: [number, string] | undefined;
	if (cursor !== undefined) {
		try {
			if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
			const bytes = Buffer.from(cursor, "base64url");
			if (bytes.toString("base64url") !== cursor) throw new Error();
			const parsed: unknown = JSON.parse(bytes.toString("utf8"));
			if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(parsed[0]) ||
				typeof parsed[0] !== "number" || typeof parsed[1] !== "string" || !/^run-[a-zA-Z0-9-]+$/.test(parsed[1])) throw new Error();
			after = parsed as [number, string];
		} catch { throw new Error("Invalid history cursor"); }
	}
	const runs = history().map(({ run }) => run).filter((r) => !after || r.ts < after[0] || (r.ts === after[0] && r.id < after[1]));
	const page = runs.slice(0, limit);
	const last = page.at(-1);
	return { runs: page, ...(last && runs.length > limit ? { nextCursor: Buffer.from(JSON.stringify([last.ts, last.id])).toString("base64url") } : {}) };
}

/** Compatibility wrapper: unlike the page API, existing callers can request all rows. */
export function listRuns(limit: number): RunSummary[] {
	return history().map(({ run }) => run).slice(0, limit);
}

function pruneRuns(currentId: string): void {
	const completed = history().filter(({ run, revision }) => revision && run.status !== "running" && run.status !== "queued");
	for (const old of completed.slice(200)) {
		if (old.run.id === currentId) continue;
		let release: (() => void) | undefined;
		try {
			const file = runFile(old.run.id); // Never trust a stored summary's path.
			release = lockRun(file);
			const disk = readJson<Checkpoint>(file);
			if (!isCheckpoint(disk)) continue;
			validateCommittedCheckpoint(disk, old.run.id); // Revalidate identity after acquiring the lock.
			if (disk.journal.hash !== old.revision || (!disk.record.endedAt && !interrupted(disk.record))) continue;
			const id = disk.record.id;
			const journal = journalPath(id, disk.journal.file);
			// Persist unpublication BEFORE deleting dependencies. A failed barrier may
			// leave orphans, never a resurrected checkpoint with missing transcript.
			fs.unlinkSync(runFile(id));
			syncDirectory(RUNS_DIR);
			fs.rmSync(journal, { force: true });
			fs.rmSync(runOutputFile(id), { force: true });
			for (const name of fs.readdirSync(RUNS_DIR)) {
				if (validTaskFile(id, name)) fs.rmSync(path.join(RUNS_DIR, name), { force: true });
			}
			syncDirectory(RUNS_DIR);
			const index = path.join(RUNS_DIR, "index", `${id}.json`);
			if (fs.existsSync(index)) { fs.unlinkSync(index); syncDirectory(path.dirname(index)); }
		} catch { /* A writer, corrupt metadata, or concurrent prune wins safely. */ }
		finally { release?.(); }
	}
}

export function loadRun(file: string): StoredRun | null {
	try {
		const disk = readJson<Checkpoint | StoredRun>(file);
		if (!disk) return null;
		if (!isCheckpoint(disk)) return disk.version === 2 ? classify(disk) : null;
		if (runFile(disk.record.id) !== path.resolve(file)) return null;
		const state = readJournal(disk);
		const data = state.checkpoint;
		const get = (name: string) => state.streams.get(name) ?? emptyStream();
		const messages = get(data.messageStream).messages;
		const run: StoredRun = {
			...data.record, ...state.values as Pick<RunRecord, ValueKey>, task: readTask(data), messages, stderr: get(data.stderrStream).stderr,
			...(data.attemptHistory === undefined ? {} : { attemptHistory: data.attemptHistory.map((attempt, i) => ({
				...attempt, ...get(`attempt-${i}`),
			})) }),
			version: 2, ts: data.ts, durationMs: data.durationMs,
			finalOutput: getFinalOutput(messages), transcript: getDisplayItems(messages),
		};
		// Detach the writer cursor from the caller's mutable reconstructed record.
		const detached = structuredClone(state);
		writers.set(run, detached);
		return classify(run);
	} catch { return null; }
}

export function loadRunById(id: string): StoredRun | null {
	const run = loadRun(runFile(id));
	return run?.id === id ? run : null;
}

export interface RunOutputPageOptions { offset?: number; limit?: number }
export interface RunOutputPage {
	text: string;
	offset: number;
	nextOffset?: number;
	totalBytes: number;
	outputFile?: string;
}
function outputText(record: RunRecord): string {
	return record.parsedOutput === undefined ? getFinalOutput(record.messages) : JSON.stringify(record.parsedOutput, null, 2);
}
function outputPage(bytes: Buffer, offset: number, totalBytes: number, limit: number, outputFile?: string): RunOutputPage {
	if (offset > totalBytes) throw new Error("Output offset exceeds output size");
	if (bytes.length && (bytes[0] & 0xc0) === 0x80) throw new Error("Output offset is inside a UTF-8 character");
	let length = Math.min(limit, totalBytes - offset);
	// One lookahead byte tells us whether the requested end splits a code point.
	while (length > 0 && offset + length < totalBytes && (bytes[length] & 0xc0) === 0x80) length--;
	if (length === 0 && offset < totalBytes) throw new Error("Output limit is too small for the next UTF-8 character; increase limit");
	return {
		text: bytes.subarray(0, length).toString("utf8"), offset, totalBytes,
		...(offset + length < totalBytes ? { nextOffset: offset + length } : {}),
		...(outputFile ? { outputFile } : {}),
	};
}
interface OpenOutput { fd: number; totalBytes: number }
function openOutput(file: string, disk: Checkpoint): OpenOutput {
	const fd = fs.openSync(file, "r");
	try {
		// Validate the descriptor, not the path: a writer can replace the pathname
		// between a stat and open. Keep this exact fd until the page has been read.
		const stat = fs.fstatSync(fd, { bigint: true });
		if (!disk.record.endedAt || disk.outputStamp !== statStamp(stat)) {
			const error = new Error("Output materialization does not match committed metadata") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		return { fd, totalBytes: Number(stat.size) };
	} catch (error) { fs.closeSync(fd); throw error; }
}
/** Nonmutating fallback for live/interrupted/legacy/stale output. Readers never
 * hold the writer lock or publish repairs: contention must not abort execution.
 * Retry a changed checkpoint rather than mixing journal generations. */
function snapshotOutputPage(id: string, file: string, offset: number, limit: number): RunOutputPage {
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = fs.readFileSync(file, "utf8");
		const run = loadRun(file);
		if (fs.readFileSync(file, "utf8") !== before) continue;
		if (!run || run.id !== id) throw new Error(`Run ${id} is unreadable`);
		const bytes = Buffer.from(outputText(run));
		return outputPage(bytes.subarray(offset, offset + limit + 1), offset, bytes.length, limit);
	}
	throw new Error(`Run ${id} output changed while reading; retry retrieval`);
}
/** UTF-8 byte paging. A valid settled materialization never replays a transcript. */
export function getRunOutputPage(id: string, { offset = 0, limit = 16 * 1024 }: RunOutputPageOptions = {}): RunOutputPage {
	const file = runOutputFile(id);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Output offset must be a nonnegative safe integer");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024) throw new Error("Output limit must be an integer from 1 to 16384");
	const metadataFile = runFile(id);
	if (!fs.existsSync(metadataFile)) throw new Error(`Run ${id} was not found`);
	const disk = hasCheckpointHeader(metadataFile) ? readJson<Checkpoint>(metadataFile) : undefined;
	if (disk) validateCommittedCheckpoint(disk, id);
	let opened: OpenOutput | undefined;
	try {
		if (!disk || !disk.record.endedAt) return snapshotOutputPage(id, metadataFile, offset, limit);
		try { opened = openOutput(file, disk); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return snapshotOutputPage(id, metadataFile, offset, limit);
		}
		const { fd, totalBytes } = opened;
		if (offset > totalBytes) throw new Error("Output offset exceeds output size");
		const bytes = Buffer.alloc(Math.min(limit + 1, totalBytes - offset));
		let read = 0;
		while (read < bytes.length) {
			const count = fs.readSync(fd, bytes, read, bytes.length - read, offset + read);
			if (!count) throw new Error("Output file was truncated during retrieval");
			read += count;
		}
		return outputPage(bytes, offset, totalBytes, limit, file);
	} finally { if (opened) fs.closeSync(opened.fd); }
}

export interface WorktreeRecord extends WorktreeInfo {
	runId: string;
	createdAt: number;
	ownerPid?: number;
	ownerRunId?: string;
}

function worktreeFile(worktreePath: string): string {
	return path.join(WORKTREES_DIR, `${createHash("sha256").update(worktreePath).digest("hex")}.json`);
}

/** Independent files eliminate the shared registry's lost-update race. */
export function registerWorktree(runId: string, info: WorktreeInfo): void {
	writeJson(worktreeFile(info.path), { ...info, runId, createdAt: Date.now() } satisfies WorktreeRecord);
}

export function listWorktreeRecords(): WorktreeRecord[] {
	const records = new Map<string, WorktreeRecord>();
	try {
		for (const r of readJson<WorktreeRecord[]>(path.join(STATE_DIR, "worktrees.json")) ?? []) records.set(r.path, r);
	} catch {
		/* corrupted legacy registry must not hide new records */
	}
	try {
		for (const name of fs.readdirSync(WORKTREES_DIR).filter((f) => f.endsWith(".json"))) {
			try {
				const r = readJson<WorktreeRecord>(path.join(WORKTREES_DIR, name));
				if (r) records.set(r.path, r);
			} catch {
				/* keep other entries visible */
			}
		}
	} catch {
		/* no worktrees yet */
	}
	return [...records.values()];
}

export function worktreeIsActive(record: WorktreeRecord): boolean {
	return record.ownerPid !== undefined && isProcessAlive(record.ownerPid);
}

export async function claimWorktree(info: WorktreeInfo, runId: string): Promise<() => Promise<void>> {
	const file = worktreeFile(info.path);
	await withLock(file, () => {
		const record = readJson<WorktreeRecord>(file) ?? { ...info, runId, createdAt: Date.now() };
		if (worktreeIsActive(record)) throw new Error(`Worktree is in use by ${record.ownerRunId}`);
		writeJson(file, { ...record, ownerPid: process.pid, ownerRunId: runId });
	});
	return async () =>
		withLock(file, () => {
			const record = readJson<WorktreeRecord>(file);
			if (record?.ownerRunId === runId) {
				delete record.ownerPid;
				delete record.ownerRunId;
				writeJson(file, record);
			}
		});
}

export async function unregisterWorktree(worktreePath: string): Promise<void> {
	fs.rmSync(worktreeFile(worktreePath), { force: true });
	const legacy = path.join(STATE_DIR, "worktrees.json");
	if (fs.existsSync(legacy))
		await withLock(legacy, () =>
			writeJson(
				legacy,
				(readJson<WorktreeRecord[]>(legacy) ?? []).filter((r) => r.path !== worktreePath),
			),
		);
}
