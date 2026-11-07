import { defaults } from "./setup.ts";
import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { Message } from "@earendil-works/pi-ai";
import { newRunRecord, emptyUsage, type AttemptRecord, type RunRecord, type VerificationEvidence } from "../src/types.ts";
import { getDisplayItems, getFinalOutput } from "../src/format.ts";
import {
	RUNS_DIR, getRunOutputPage, listRuns, listRunsPage, loadRun, loadRunById, runFile, runOutputFile, saveRun,
} from "../src/store.ts";

beforeEach(() => fs.rmSync(RUNS_DIR, { recursive: true, force: true }));

function assistant(text: string, timestamp = 1): Extract<Message, { role: "assistant" }> {
	return {
		role: "assistant", content: [{ type: "text", text }], timestamp,
		api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function record(id = `run-${randomUUID()}`, timestamp = 100): RunRecord {
	const run = newRunRecord(id, "fixture", "user", "fixture task", defaults.cwd);
	run.startedAt = timestamp;
	run.ownerPid = process.pid;
	run.status = "running";
	return run;
}
function attempt(number: number, messages: Message[] = []): AttemptRecord {
	return { number, status: "running", startedAt: number * 100, messages, diagnostics: [],
		stderr: "", usage: emptyUsage(), sessionFile: `/fixture/attempt-${number}.jsonl` };
}
function checkpoint(run: RunRecord) {
	return JSON.parse(fs.readFileSync(runFile(run.id), "utf8"));
}
function journal(run: RunRecord): string {
	return path.join(RUNS_DIR, checkpoint(run).journal.file);
}
function legacy(run: RunRecord): string {
	const file = runFile(run.id);
	fs.mkdirSync(RUNS_DIR, { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ ...run, version: 2, ts: run.startedAt, durationMs: 42,
		finalOutput: getFinalOutput(run.messages), transcript: getDisplayItems(run.messages) }, null, 2));
	return file;
}
interface FsEvent { kind: "sync" | "rename" | "unlink" | "remove"; file: string; to?: string }
function traceFiles(fn: () => void): FsEvent[] {
	const events: FsEvent[] = [];
	const descriptors = new Map<number, string>();
	const { openSync, fsyncSync, renameSync, unlinkSync, rmSync } = fs;
	const mocks = [
		mock.method(fs, "openSync", (file: any, ...args: any[]) => {
			const fd = (openSync as any)(file, ...args);
			descriptors.set(fd, String(file));
			return fd;
		}),
		mock.method(fs, "fsyncSync", (fd: number) => {
			events.push({ kind: "sync", file: descriptors.get(fd) ?? String(fd) });
			return fsyncSync(fd);
		}),
		mock.method(fs, "renameSync", (from: any, to: any) => {
			events.push({ kind: "rename", file: String(from), to: String(to) });
			return renameSync(from, to);
		}),
		mock.method(fs, "unlinkSync", (file: any) => {
			events.push({ kind: "unlink", file: String(file) });
			return unlinkSync(file);
		}),
		mock.method(fs, "rmSync", (file: any, ...args: any[]) => {
			events.push({ kind: "remove", file: String(file) });
			return (rmSync as any)(file, ...args);
		}),
	];
	syncBuiltinESMExports();
	try { fn(); } finally { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); }
	return events;
}
function directorySyncedBetween(events: FsEvent[], after: number, before: number, directory = RUNS_DIR): boolean {
	return events.slice(after + 1, before).some((event) => event.kind === "sync" && event.file === directory);
}
function withoutJournalReads<T>(fn: () => T, allowWrites = false): T {
	const read = fs.readFileSync;
	const open = fs.openSync;
	const mocks = [
		mock.method(fs, "readFileSync", (file: any, ...args: any[]) => {
			assert.ok(!String(file).endsWith(".jsonl"), `unexpected journal read: ${file}`);
			assert.ok(!String(file).endsWith(".task.txt"), `unexpected full task read: ${file}`);
			return (read as any)(file, ...args);
		}),
		mock.method(fs, "openSync", (file: any, ...args: any[]) => {
			assert.ok(!String(file).endsWith(".jsonl") || (allowWrites && args[0] === "r+"), `unexpected journal open: ${file}`);
			assert.ok(!String(file).endsWith(".task.txt"), `unexpected full task open: ${file}`);
			return (open as any)(file, ...args);
		}),
	];
	syncBuiltinESMExports();
	try { return fn(); } finally { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); }
}

test("explicit run lookup cannot adopt another checkpoint or legacy identity", () => {
	const a = record();
	const b = record();
	saveRun(a);
	saveRun(b);
	fs.copyFileSync(runFile(b.id), runFile(a.id));
	assert.equal(loadRun(runFile(a.id)), null);
	assert.equal(loadRunById(a.id), null);
	assert.equal(loadRunById(b.id)?.id, b.id);
	fs.copyFileSync(legacy(b), runFile(a.id));
	assert.equal(loadRunById(a.id), null);
});

test("complete attempts/messages/diagnostics/stderr round-trip, including edits and alias changes", () => {
	const run = record();
	const first = attempt(1, [assistant("failed attempt")]);
	first.status = "error";
	first.endedAt = 150;
	first.diagnostics = ["transient", "terminal"];
	first.errorMessage = "terminal";
	first.stderr = "first stderr\n";
	first.exitCode = 1;
	const second = attempt(2, [assistant("last answer")]);
	run.attemptHistory = [first, second];
	run.attempts = 2;
	run.messages = second.messages;
	run.stderr = second.stderr;
	run.usage.cost = 1.25;
	run.parsedOutput = { result: "structured" };
	run.outputSchema = { type: "object" };
	run.artifacts = { changedFiles: ["a.ts"], verification: [{ command: "true", output: "evidence", exitCode: 0 }] };
	saveRun(run);
	second.messages.push({ role: "user", content: "continuation", timestamp: 2 }, assistant("new answer", 3));
	second.diagnostics.push("nonfatal");
	second.stderr = "second stderr\n";
	run.stderr = second.stderr;
	saveRun(run);
	const loaded = loadRunById(run.id)!;
	assert.deepEqual(loaded.attemptHistory, run.attemptHistory);
	assert.deepEqual(loaded.messages, run.messages);
	assert.equal(loaded.messages, loaded.attemptHistory![1].messages);
	assert.equal(loaded.stderr, "second stderr\n");
	assert.equal(loaded.finalOutput, "new answer");
	assert.deepEqual(loaded.transcript, getDisplayItems(run.messages));
	assert.deepEqual(loaded.artifacts, run.artifacts);
	assert.deepEqual(loaded.parsedOutput, run.parsedOutput);
	assert.deepEqual(loaded.outputSchema, run.outputSchema);
	assert.equal(loaded.version, 2, "public loaded snapshot stays v2 compatible");

	// Formerly shared root/attempt streams can diverge, truncate, and be edited in place.
	(second.messages[0] as Extract<Message, { role: "assistant" }>).content = [{ type: "text", text: "edited" }];
	second.messages.splice(1);
	second.diagnostics.splice(0, 1, "replaced");
	second.stderr = "short";
	run.messages = [assistant("independent root")];
	run.stderr = "independent stderr";
	run.parsedOutput = undefined;
	run.artifacts!.verification[0].output = "edited evidence";
	saveRun(run);
	const edited = loadRunById(run.id)!;
	assert.deepEqual(edited.attemptHistory, run.attemptHistory);
	assert.deepEqual(edited.messages, run.messages);
	assert.equal(edited.stderr, run.stderr);
	assert.equal(edited.parsedOutput, undefined);
	assert.deepEqual(edited.artifacts, run.artifacts);
	assert.equal(edited.finalOutput, "independent root");
});

test("100 repeated 48 KiB messages append roughly linearly; checkpoints never serialize accumulated output", (t) => {
	const run = record();
	const current = attempt(1);
	run.attempts = 1;
	run.attemptHistory = [current];
	run.messages = current.messages;
	run.task = "TASK-MARKER" + "t".repeat(48 * 1024);
	run.outputSchema = { description: "SCHEMA-MARKER" + "s".repeat(48 * 1024) };
	run.parsedOutput = { result: "PARSED-MARKER" + "p".repeat(48 * 1024) };
	const payload = "m".repeat(48 * 1024);
	const sizes: number[] = [];
	for (let i = 0; i < 100; i++) {
		current.messages.push(assistant(payload, i));
		saveRun(run);
		sizes.push(fs.statSync(journal(run)).size);
		assert.ok(fs.statSync(runFile(run.id)).size < 4096, "metadata checkpoint must stay small");
	}
	const file = journal(run);
	const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
	assert.equal(lines.length, 100);
	for (let i = 1; i < lines.length; i++) {
		assert.ok(!lines[i].includes("SCHEMA-MARKER"));
		assert.ok(!lines[i].includes("PARSED-MARKER"));
		assert.ok(!lines[i].includes("TASK-MARKER"));
		assert.equal(JSON.parse(lines[i]).data.changes[0].messages.values.length, 1);
	}
	const firstHalf = sizes[49] - sizes[0];
	const secondHalf = sizes[99] - sizes[49];
	assert.ok(secondHalf / firstHalf < 1.1, `nonlinear append growth: ${secondHalf / firstHalf}`);
	assert.ok(sizes[99] < 100 * 53 * 1024, `unexpected journal amplification: ${sizes[99]}`);
	const before = fs.statSync(file).size;
	const stringify = JSON.stringify;
	const spy = mock.method(JSON, "stringify", (...args: any[]) => {
		const text = (stringify as any)(...args);
		assert.ok(!text?.includes(payload), "a metadata-only save serialized historical messages");
		assert.ok(!text?.includes("SCHEMA-MARKER"));
		assert.ok(!text?.includes("PARSED-MARKER"));
		assert.ok(!text?.includes(run.task), "only the bounded task summary belongs in metadata");
		return text;
	});
	try { withoutJournalReads(() => saveRun(run), true); } finally { spy.mock.restore(); }
	assert.ok(fs.statSync(file).size - before < 4096);
	assert.equal(loadRunById(run.id)!.messages.length, 100);
	t.diagnostic(`48 KiB x100: ${sizes[99]} appended journal bytes; halves ${firstHalf}/${secondHalf}; checkpoint ${fs.statSync(runFile(run.id)).size} bytes`);
});

test("100 appended 8 KiB verification entries use linear suffix changes and small checkpoints", (t) => {
	const run = record();
	const current = attempt(1);
	current.verification = [];
	run.attempts = 1;
	run.attemptHistory = [current];
	run.messages = current.messages;
	const payload = "VERIFICATION-PAYLOAD" + "v".repeat(8192 - "VERIFICATION-PAYLOAD".length);
	const sizes: number[] = [];
	for (let i = 0; i < 100; i++) {
		current.verification.push({ runId: run.id, attempt: 1, toolCallId: `same/${i}`, parentToolCallId: `parent/${i % 3}`,
			command: `check ${i}`, output: payload, outcome: "completed", endObserved: true, exitCode: i % 2 });
		saveRun(run);
		sizes.push(fs.statSync(journal(run)).size);
	}
	assert.ok(fs.statSync(runFile(run.id)).size < 4096, "verification bulk must not be in checkpoint metadata");
	assert.ok(!fs.readFileSync(runFile(run.id), "utf8").includes("VERIFICATION-PAYLOAD"));
	const firstHalf = sizes[49] - sizes[0];
	const secondHalf = sizes[99] - sizes[49];
	assert.ok(secondHalf / firstHalf < 1.1, `nonlinear verification append growth: ${secondHalf / firstHalf}`);
	assert.ok(sizes[99] < 100 * 11 * 1024, `verification journal amplification: ${sizes[99]}`);
	const lines = fs.readFileSync(journal(run), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).data);
	for (let i = 0; i < lines.length; i++) {
		assert.equal(lines[i].checkpoint.attemptHistory[0].verification, undefined);
		const patch = lines[i].changes.find((change: any) => change.stream === "attempt-0").verification;
		assert.equal(patch.length, i + 1);
		assert.deepEqual(patch.updates, [{ index: i, value: current.verification[i] }]);
	}
	assert.deepEqual(loadRunById(run.id)!.attemptHistory, run.attemptHistory);
	const before = fs.statSync(journal(run)).size;
	const stringify = JSON.stringify;
	const spy = mock.method(JSON, "stringify", (...args: any[]) => {
		const text = (stringify as any)(...args);
		assert.ok(!text?.includes(payload), "an unchanged save rewrote accumulated verification evidence");
		return text;
	});
	try { withoutJournalReads(() => saveRun(run), true); } finally { spy.mock.restore(); }
	assert.ok(fs.statSync(journal(run)).size - before < 4096);
	const hydrated = loadRunById(run.id)!;
	withoutJournalReads(() => saveRun(hydrated), true);
	assert.deepEqual(loadRunById(run.id)!.attemptHistory, run.attemptHistory);
	t.diagnostic(`8 KiB x100 verification: ${sizes[99]} journal bytes; halves ${firstHalf}/${secondHalf}; checkpoint ${fs.statSync(runFile(run.id)).size} bytes`);
});

test("100 saves mutate the first 8 KiB evidence while appending 8 KiB evidence without suffix amplification", (t) => {
	const run = record();
	const current = attempt(1);
	current.verification = [{ command: "long-running first", output: "initial" }];
	run.attemptHistory = [current];
	const sizes: number[] = [];
	for (let i = 0; i < 100; i++) {
		current.verification[0].output = `${i}:` + "m".repeat(8192);
		current.verification.push({ command: `concurrent ${i}`, output: "a".repeat(8192), toolCallId: `call-${i}` });
		saveRun(run);
		sizes.push(fs.statSync(journal(run)).size);
	}
	const firstHalf = sizes[49] - sizes[0], secondHalf = sizes[99] - sizes[49];
	t.diagnostic(`mutating/appending 8 KiB x100: ${sizes[99]} journal bytes; halves ${firstHalf}/${secondHalf}`);
	assert.ok(secondHalf / firstHalf < 1.1, `mutable verification suffix amplification: ${secondHalf / firstHalf}`);
	assert.ok(sizes[99] < 100 * 20 * 1024, `mutable verification journal amplification: ${sizes[99]}`);
	const transactions = fs.readFileSync(journal(run), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).data);
	for (let i = 0; i < transactions.length; i++) {
		const patch = transactions[i].changes.find((change: any) => change.stream === "attempt-0").verification;
		assert.equal(patch.length, i + 2);
		assert.deepEqual(patch.updates.map((update: any) => update.index), [0, i + 1]);
	}
	const hydrated = loadRunById(run.id)!;
	assert.deepEqual(hydrated.attemptHistory, run.attemptHistory);
	const before = fs.statSync(journal(run)).size;
	withoutJournalReads(() => saveRun(hydrated), true);
	assert.ok(fs.statSync(journal(run)).size - before < 4096);
	// Reordering, deletion and replacement of the caller's array must round-trip too.
	hydrated.attemptHistory![0].verification = [current.verification[100], current.verification[0]];
	saveRun(hydrated);
	assert.deepEqual(loadRunById(run.id)!.attemptHistory, hydrated.attemptHistory);
});

test("verification streams retain exact identities, in-place edits, empty/absent legacy fields and artifacts", () => {
	const run = record();
	const evidence: VerificationEvidence[] = [
		{ command: "legacy optional identity", output: "old output" },
		{ runId: run.id, attempt: 1, toolCallId: "reused", parentToolCallId: "parent/one", command: "one", output: "first" },
		{ runId: run.id, attempt: 1, toolCallId: "reused", parentToolCallId: "parent/two", command: "two", output: "second" },
	];
	run.attemptHistory = [attempt(1), attempt(2), attempt(3)];
	run.attemptHistory[0].verification = evidence;
	run.attemptHistory[1].verification = [];
	run.artifacts = { changedFiles: [], verification: evidence };
	saveRun(run);
	assert.deepEqual(loadRunById(run.id)!.attemptHistory, run.attemptHistory);
	assert.deepEqual(loadRunById(run.id)!.artifacts, run.artifacts);
	evidence[1].output = "edited in place";
	evidence.pop();
	run.attemptHistory[1].verification = undefined;
	run.attemptHistory[2].verification = [];
	saveRun(run);
	const loaded = loadRunById(run.id)!;
	assert.deepEqual(loaded.attemptHistory, JSON.parse(JSON.stringify(run.attemptHistory)));
	assert.deepEqual(loaded.artifacts, run.artifacts);
	assert.equal(Object.hasOwn(loaded.attemptHistory![1], "verification"), false);
	assert.deepEqual(loaded.attemptHistory![2].verification, []);
});

test("v2 and legacy v3 checkpoint verification hydrate and migrate once without rewriting evidence", () => {
	for (const version of [2, 3]) {
		const run = record();
		run.attemptHistory = [attempt(1), attempt(2), attempt(3)];
		run.attemptHistory[0].verification = [{ command: "legacy evidence", output: "legacy".repeat(1500) },
			{ runId: run.id, attempt: 1, toolCallId: "exact", parentToolCallId: "parent", command: "modern identity", output: "exact" }];
		run.attemptHistory[1].verification = [];
		if (version === 2) legacy(run);
		else {
			saveRun(run);
			// Construct a checksummed pre-stream v3 transaction/checkpoint, independent of the current writer format.
			const disk = checkpoint(run);
			const tx = JSON.parse(fs.readFileSync(journal(run), "utf8").trim()).data;
			for (const change of tx.changes) delete change.verification;
			for (let i = 0; i < 2; i++) tx.checkpoint.attemptHistory[i].verification = run.attemptHistory[i].verification;
			disk.attemptHistory = tx.checkpoint.attemptHistory;
			const checksum = createHash("sha256").update(JSON.stringify(tx)).digest("hex");
			const line = JSON.stringify({ checksum, data: tx }) + "\n";
			fs.writeFileSync(journal(run), line);
			disk.journal.hash = checksum;
			disk.journal.bytes = Buffer.byteLength(line);
			fs.writeFileSync(runFile(run.id), JSON.stringify(disk));
		}
		const loaded = loadRunById(run.id)!;
		assert.deepEqual(loaded.attemptHistory, run.attemptHistory, `v${version}`);
		saveRun(loaded);
		assert.ok(checkpoint(run).attemptHistory.every((entry: any) => !Object.hasOwn(entry, "verification")));
		assert.deepEqual(loadRunById(run.id)!.attemptHistory, run.attemptHistory);
		const before = fs.statSync(journal(run)).size;
		saveRun(loaded);
		assert.ok(fs.statSync(journal(run)).size - before < 4096, `v${version} migrated evidence was rewritten`);
	}
});

test("verification stream changes share checkpoint publication and coherent torn-tail recovery", () => {
	const run = record();
	const current = attempt(1);
	current.verification = [{ command: "committed", output: "committed evidence" }];
	run.attemptHistory = [current];
	saveRun(run);
	const file = journal(run);
	const prefix = fs.statSync(file).size;
	current.verification[0].output = "edited evidence";
	current.verification.push({ command: "pending", output: "pending evidence" });
	const rename = fs.renameSync;
	const fail = mock.method(fs, "renameSync", (from: any, to: any) => {
		if (String(to) === runFile(run.id)) throw new Error("injected verification checkpoint failure");
		return rename(from, to);
	});
	syncBuiltinESMExports();
	try { assert.throws(() => saveRun(run), /injected verification/); }
	finally { fail.mock.restore(); syncBuiltinESMExports(); }
	assert.deepEqual(loadRunById(run.id)!.attemptHistory![0].verification, [{ command: "committed", output: "committed evidence" }]);
	saveRun(run);
	assert.deepEqual(loadRunById(run.id)!.attemptHistory![0].verification, current.verification);
	fs.truncateSync(file, prefix + Math.floor((fs.statSync(file).size - prefix) / 2));
	const recovered = loadRunById(run.id)!;
	assert.deepEqual(recovered.attemptHistory![0].verification, [{ command: "committed", output: "committed evidence" }]);
	saveRun(recovered);
	assert.deepEqual(loadRunById(run.id)!.attemptHistory![0].verification, recovered.attemptHistory![0].verification);
});

test("a separate process loads and saves without duplicating transcripts", () => {
	const run = record();
	run.messages = [assistant("original" + "x".repeat(48 * 1024))];
	saveRun(run);
	const file = journal(run);
	const before = fs.readFileSync(file);
	const script = `import { loadRunById, saveRun } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
		const run = loadRunById(${JSON.stringify(run.id)});
		if (!run) throw new Error('missing run');
		saveRun(run);
		run.messages.push({role:'user',content:'new message',timestamp:2});
		saveRun(run);`;
	execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: process.env, timeout: 10000 });
	const after = fs.readFileSync(file);
	assert.deepEqual(after.subarray(0, before.length), before);
	assert.ok(after.length - before.length < 8192);
	const entries = after.toString().trimEnd().split("\n").map((line) => JSON.parse(line).data);
	assert.equal(entries[1].changes.length, 0);
	assert.equal(entries[2].changes[0].messages.offset, 1);
	assert.equal(loadRunById(run.id)!.messages.length, 2);
});

test("v2 loads/listing remain compatible and migration preserves the original snapshot", () => {
	const run = record();
	run.messages = [assistant('LEGACY-TRANSCRIPT "quote" \\ { [ ] }')];
	run.attemptHistory = [attempt(1, run.messages)];
	run.ownerPid = 2147483647;
	run.childPid = 2147483646;
	const file = legacy(run);
	const original = fs.readFileSync(file);
	const parse = JSON.parse;
	const spy = mock.method(JSON, "parse", (text: string, ...args: any[]) => {
		assert.ok(!text.includes("LEGACY-TRANSCRIPT"), "history deserialized a legacy transcript");
		return (parse as any)(text, ...args);
	});
	try {
		assert.equal(listRuns(10)[0].status, "interrupted");
		assert.equal(listRunsPage({ limit: 1 }).runs[0].task, run.task);
	} finally { spy.mock.restore(); }
	const read = fs.readFileSync;
	const readSpy = mock.method(fs, "readFileSync", (target: any, ...args: any[]) => {
		assert.notEqual(String(target), file, "legacy history re-read the transcript-bearing snapshot after indexing");
		return (read as any)(target, ...args);
	});
	syncBuiltinESMExports();
	try { assert.equal(listRuns(10)[0].status, "interrupted"); }
	finally { readSpy.mock.restore(); syncBuiltinESMExports(); }
	const loaded = loadRun(file)!;
	assert.equal(loaded.status, "interrupted");
	assert.equal(loaded.attemptHistory![0].status, "interrupted");
	assert.equal(loaded.finalOutput, getFinalOutput(run.messages));
	saveRun(loaded);
	assert.equal(checkpoint(run).version, 3);
	assert.deepEqual(fs.readFileSync(`${file}.v2-backup`), original);
	assert.deepEqual(loadRunById(run.id)!.messages, run.messages);
	const bytes = fs.statSync(journal(run)).size;
	saveRun(loaded);
	assert.ok(fs.statSync(journal(run)).size - bytes < 4096);
	assert.deepEqual(fs.readFileSync(`${file}.v2-backup`), original);
});

test("migration atomically replaces partial v2 backups and verifies backup bytes before replacing the source", () => {
	for (const failure of ["rename", "short-write"] as const) {
		const run = record();
		run.messages = [assistant("original legacy transcript")];
		const file = legacy(run);
		const original = fs.readFileSync(file);
		const backup = `${file}.v2-backup`;
		fs.writeFileSync(backup, original.subarray(0, Math.floor(original.length / 2)));
		const { renameSync, openSync, writeFileSync } = fs;
		let backupFd: number | undefined;
		let injected = false;
		const mocks = [
			mock.method(fs, "openSync", (target: any, ...args: any[]) => {
				const fd = (openSync as any)(target, ...args);
				if (String(target).startsWith(`${backup}.`) && String(target).endsWith(".tmp")) backupFd = fd;
				else if (fd === backupFd) backupFd = undefined;
				return fd;
			}),
			mock.method(fs, "writeFileSync", (target: any, data: any, ...args: any[]) => {
				if (failure === "short-write" && target === backupFd) { injected = true; data = Buffer.from(data).subarray(0, 32); }
				return (writeFileSync as any)(target, data, ...args);
			}),
			mock.method(fs, "renameSync", (from: any, to: any) => {
				if (failure === "rename" && String(to) === backup) { injected = true; throw new Error("injected backup rename failure"); }
				return renameSync(from, to);
			}),
		];
		syncBuiltinESMExports();
		try { assert.throws(() => saveRun(run), /backup/i); }
		finally { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); }
		assert.ok(injected);
		assert.deepEqual(fs.readFileSync(file), original, "migration destroyed the sole complete legacy snapshot");
		saveRun(run);
		assert.deepEqual(fs.readFileSync(backup), original);
		assert.equal(checkpoint(run).version, 3);
		assert.equal(loadRunById(run.id)?.finalOutput, "original legacy transcript");
		assert.ok(!fs.readdirSync(RUNS_DIR).some((name) => name.endsWith(".tmp")));
	}
});

test("unterminated tails and torn committed writes recover coherent preceding snapshots", () => {
	const run = record();
	run.messages.push(assistant("first"));
	saveRun(run);
	const file = journal(run);
	const first = fs.readFileSync(file);
	fs.appendFileSync(file, '{"checksum":"torn');
	assert.equal(loadRunById(run.id)!.finalOutput, "first");
	const loaded = loadRunById(run.id)!;
	loaded.messages.push(assistant("second"));
	saveRun(loaded);
	assert.deepEqual(fs.readFileSync(file).subarray(0, first.length), first);
	const second = fs.readFileSync(file);
	loaded.status = "ok";
	loaded.endedAt = 200;
	loaded.messages.push(assistant("uncommitted final"));
	saveRun(loaded);
	const complete = fs.readFileSync(file);
	fs.truncateSync(file, second.length + Math.floor((complete.length - second.length) / 2));
	const recovered = loadRunById(run.id)!;
	assert.equal(recovered.status, "running");
	assert.equal(recovered.endedAt, undefined);
	assert.equal(recovered.finalOutput, "second");
	assert.equal(recovered.messages.length, 2);
	saveRun(recovered);
	assert.equal(loadRunById(run.id)!.finalOutput, "second");
	assert.ok(!fs.readFileSync(file, "utf8").includes("uncommitted final"));
});

test("recovered checkpoints are committed before reusing a torn committed tail, including a second publication failure", () => {
	for (const failAt of [1, 2]) {
		const run = record();
		run.messages = [assistant("stable prefix")];
		saveRun(run);
		const file = journal(run);
		const prefix = fs.statSync(file).size;
		run.messages.push(assistant("torn committed tail"));
		run.status = "ok";
		run.endedAt = 200;
		saveRun(run);
		fs.truncateSync(file, prefix + Math.floor((fs.statSync(file).size - prefix) / 2));
		const torn = fs.readFileSync(file);
		const recovered = loadRunById(run.id)!;
		assert.equal(recovered.finalOutput, "stable prefix");
		recovered.messages.push(assistant("replacement tail"));
		const rename = fs.renameSync;
		let publications = 0;
		const fail = mock.method(fs, "renameSync", (from: any, to: any) => {
			if (String(to) === runFile(run.id) && ++publications === failAt) throw new Error("injected recovery publication failure");
			return rename(from, to);
		});
		syncBuiltinESMExports();
		try { assert.throws(() => saveRun(recovered), /injected recovery/); }
		finally { fail.mock.restore(); syncBuiltinESMExports(); }
		assert.equal(publications, failAt);
		assert.equal(loadRunById(run.id)?.finalOutput, "stable prefix", `failure at publication ${failAt} lost the preceding snapshot`);
		if (failAt === 1) assert.deepEqual(fs.readFileSync(file), torn, "tail was reused before recovery was published");
		else assert.equal(checkpoint(run).journal.sequence, 1);
		saveRun(recovered);
		assert.equal(loadRunById(run.id)?.finalOutput, "replacement tail");
		assert.equal(checkpoint(run).journal.sequence, 2);
	}
});

test("journal replay appends do not repeatedly copy accumulated message/diagnostic prefixes", () => {
	const run = record();
	const current = attempt(1);
	run.attemptHistory = [current];
	run.messages = current.messages;
	for (let i = 0; i < 100; i++) {
		current.messages.push(assistant(`replay-${i}`));
		current.diagnostics.push(`diagnostic-${i}`);
		saveRun(run);
	}
	const slice = Array.prototype.slice;
	let copied = 0;
	Array.prototype.slice = function (this: any[], start?: number, end?: number) {
		if (start === 0 && this.length && (this[0]?.role === "assistant" || String(this[0]).startsWith("diagnostic-")))
			copied += Math.min(end ?? this.length, this.length);
		return slice.call(this, start, end);
	};
	let loaded: ReturnType<typeof loadRunById>;
	try { loaded = loadRunById(run.id); } finally { Array.prototype.slice = slice; }
	assert.ok(loaded);
	assert.deepEqual(loaded.messages, current.messages);
	assert.deepEqual(loaded.attemptHistory![0].diagnostics, current.diagnostics);
	assert.ok(copied <= 200, `replay copied ${copied} historical elements for 200 appended elements`);
});

test("interior corruption, checksum damage, and complete malformed final lines fail closed", () => {
	for (const damage of ["json", "checksum", "complete-tail"] as const) {
		const run = record();
		for (let i = 0; i < 3; i++) { run.messages.push(assistant(`message-${i}`)); saveRun(run); }
		const file = journal(run);
		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
		if (damage === "json") lines[1] = "{interior corruption}";
		if (damage === "checksum") lines[1] = lines[1].replace("message-1", "damaged-1");
		if (damage === "complete-tail") lines.push("{broken final line}");
		fs.writeFileSync(file, lines.join("\n") + "\n");
		const corrupted = fs.readFileSync(file);
		assert.equal(loadRunById(run.id), null, damage);
		assert.throws(() => saveRun(run), { name: /Error/ }, damage);
		assert.deepEqual(fs.readFileSync(file), corrupted, "failed save must not truncate interior corruption");
	}
});

test("metadata history never opens journals, even for interrupted owners or corrupt transcripts", () => {
	const dead = record("run-dead", 100);
	dead.ownerPid = 2147483647;
	dead.childPid = 2147483646;
	dead.attemptHistory = [attempt(1, [assistant("payload")])];
	dead.messages = dead.attemptHistory[0].messages;
	const live = record("run-live", 101);
	const child = record("run-child", 102);
	child.ownerPid = 2147483647;
	child.childPid = process.pid;
	for (const run of [dead, live, child]) saveRun(run);
	fs.writeFileSync(journal(dead), "corrupt\n");
	withoutJournalReads(() => {
		assert.deepEqual(listRuns(20).map((r) => [r.id, r.status]), [
			[child.id, "running"], [live.id, "running"], [dead.id, "interrupted"],
		]);
		assert.equal(listRunsPage({ limit: 1 }).runs[0].id, child.id);
	});
	assert.equal(loadRunById(dead.id), null);
});

test("history pages have stable timestamp+id ordering and strictly bounded limits/cursors", () => {
	for (const [id, ts] of [["run-a", 100], ["run-c", 100], ["run-b", 100], ["run-old", 99]] as const) saveRun(record(id, ts));
	const first = listRunsPage({ limit: 2 });
	assert.deepEqual(first.runs.map((r) => r.id), ["run-c", "run-b"]);
	assert.ok(first.nextCursor);
	saveRun(record("run-new", 200));
	fs.unlinkSync(runFile("run-b")); // Cursor is a key, not a fragile array index or file lookup.
	const second = listRunsPage({ limit: 2, cursor: first.nextCursor });
	assert.deepEqual(second.runs.map((r) => r.id), ["run-a", "run-old"]);
	assert.equal(second.nextCursor, undefined);
	assert.deepEqual(listRuns(2).map((r) => r.id), ["run-new", "run-c"]);
	assert.deepEqual(listRuns(0), []);
	assert.deepEqual(listRunsPage({ limit: 1, cursor: Buffer.from(JSON.stringify([0, "run-z"])).toString("base64url") }), { runs: [] });
	for (const limit of [0, -1, 1.1, 51, Number.MAX_SAFE_INTEGER, NaN, Infinity])
		assert.throws(() => listRunsPage({ limit }), /limit/);
	for (const cursor of ["", "not-base64!", "e30", Buffer.from(JSON.stringify([100, "../bad"])).toString("base64url"),
		Buffer.from(JSON.stringify(["100", "run-a"])).toString("base64url")]) assert.throws(() => listRunsPage({ cursor }), /cursor/);
	assert.throws(() => runFile("../bad"), /Invalid run id/);
});

test("failed checkpoint rename leaves the previous snapshot coherent and retries do not duplicate data", () => {
	const run = record();
	run.messages = [assistant("committed")];
	saveRun(run);
	const file = journal(run);
	run.messages.push(assistant("pending"));
	const rename = fs.renameSync;
	const fail = mock.method(fs, "renameSync", (from: any, to: any) => {
		if (String(to) === runFile(run.id)) throw new Error("injected checkpoint failure");
		return rename(from, to);
	});
	syncBuiltinESMExports();
	try { assert.throws(() => saveRun(run), /injected/); }
	finally { fail.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(loadRunById(run.id)!.finalOutput, "committed");
	saveRun(run);
	assert.equal(loadRunById(run.id)!.messages.length, 2);
	assert.equal(fs.readFileSync(file, "utf8").split('"text":"pending"').length - 1, 1);
});

test("failed output/checkpoint publication cannot bless uncommitted output on an unchanged retry", () => {
	for (const source of ["messages", "parsedOutput"] as const) {
		const run = record();
		run.messages = [assistant("committed A")];
		if (source === "parsedOutput") run.parsedOutput = { answer: "committed A" };
		run.endedAt = 200;
		run.status = "ok";
		saveRun(run);
		const committed = fs.readFileSync(runOutputFile(run.id), "utf8");
		if (source === "messages") run.messages = [assistant("uncommitted B")];
		else run.parsedOutput = { answer: "uncommitted B" };
		const rename = fs.renameSync;
		const fail = mock.method(fs, "renameSync", (from: any, to: any) => {
			if (String(to) === runFile(run.id)) throw new Error("injected output checkpoint failure");
			return rename(from, to);
		});
		syncBuiltinESMExports();
		try { assert.throws(() => saveRun(run), /injected output/); }
		finally { fail.mock.restore(); syncBuiltinESMExports(); }
		assert.match(fs.readFileSync(runOutputFile(run.id), "utf8"), /uncommitted B/);
		if (source === "messages") run.messages = [assistant("committed A")];
		else run.parsedOutput = { answer: "committed A" };
		saveRun(run); // A failed append invalidates the writer cursor, so replay is allowed here.
		assert.equal(fs.readFileSync(runOutputFile(run.id), "utf8"), committed);
		withoutJournalReads(() => assert.equal(getRunOutputPage(run.id).text, committed));
	}
});

test("settled output is regenerated when selecting a different unchanged message stream", () => {
	const run = record();
	run.attemptHistory = [attempt(1, [assistant("first stream")]), attempt(2, [assistant("second stream")])];
	run.messages = run.attemptHistory[1].messages;
	run.endedAt = 300;
	run.status = "ok";
	saveRun(run);
	run.messages = run.attemptHistory[0].messages;
	withoutJournalReads(() => saveRun(run), true);
	assert.equal(checkpoint(run).messageStream, "attempt-0");
	assert.equal(getRunOutputPage(run.id).text, "first stream");
});

test("output paging validates the opened descriptor, not a path stat before open", () => {
	const run = record();
	run.messages = [assistant("committed A")];
	run.endedAt = 200;
	run.status = "ok";
	saveRun(run);
	const output = runOutputFile(run.id);
	const replacement = `${output}.replacement`;
	fs.writeFileSync(replacement, "uncommitted B");
	const open = fs.openSync;
	let replaced = false;
	const race = mock.method(fs, "openSync", (file: any, ...args: any[]) => {
		if (String(file) === output && args[0] === "r" && !replaced) {
			replaced = true;
			fs.renameSync(replacement, output);
		}
		return (open as any)(file, ...args);
	});
	syncBuiltinESMExports();
	try { assert.equal(getRunOutputPage(run.id).text, "committed A"); }
	finally { race.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(replaced);
});

test("output paging retains its validated descriptor when the pathname changes during reading", () => {
	const run = record();
	run.messages = [assistant("committed A")];
	run.endedAt = 200;
	run.status = "ok";
	saveRun(run);
	const output = runOutputFile(run.id);
	const replacement = `${output}.replacement`;
	fs.writeFileSync(replacement, "uncommitted B");
	const { openSync, readSync } = fs;
	let replaced = false;
	let outputFd: number | undefined;
	const mocks = [
		mock.method(fs, "openSync", (file: any, ...args: any[]) => {
			const fd = (openSync as any)(file, ...args);
			if (String(file) === output && args[0] === "r") outputFd = fd;
			return fd;
		}),
		mock.method(fs, "readSync", (fd: number, ...args: any[]) => {
			if (fd === outputFd && !replaced) {
				replaced = true;
				fs.renameSync(replacement, output);
			}
			return (readSync as any)(fd, ...args);
		}),
	];
	syncBuiltinESMExports();
	try { assert.equal(getRunOutputPage(run.id).text, "committed A"); }
	finally { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(replaced);
	assert.equal(getRunOutputPage(run.id).text, "committed A", "stale output falls back to committed transcript bytes");
	assert.equal(fs.readFileSync(output, "utf8"), "uncommitted B", "readers must not publish repairs");
});

test("checkpoint/dependency publication fsyncs files and directories, and unpublishes output before deletion", () => {
	const run = record();
	run.messages = [assistant("durable output")];
	run.endedAt = 200;
	run.status = "ok";
	const events = traceFiles(() => saveRun(run));
	const metadata = runFile(run.id);
	const publication = events.findIndex((event) => event.kind === "rename" && event.to === metadata);
	assert.ok(publication >= 0);
	assert.ok(events.slice(0, publication).some((event) => event.kind === "sync" && event.file === events[publication].file), "checkpoint temp was not fsynced before rename");
	assert.ok(directorySyncedBetween(events, publication, events.length), "checkpoint rename was not directory-fsynced");
	const journalSync = events.findIndex((event) => event.kind === "sync" && event.file === journal(run));
	assert.ok(journalSync >= 0 && journalSync < publication);
	assert.ok(directorySyncedBetween(events, journalSync, publication), "new journal entry was not made durable before checkpoint publication");
	for (const dependency of [runOutputFile(run.id), path.join(RUNS_DIR, checkpoint(run).taskFile)]) {
		const rename = events.findIndex((event) => event.kind === "rename" && event.to === dependency);
		assert.ok(rename >= 0 && rename < publication);
		assert.ok(events.slice(0, rename).some((event) => event.kind === "sync" && event.file === events[rename].file));
		assert.ok(directorySyncedBetween(events, rename, publication), `dependency ${dependency} was not directory-fsynced before checkpoint publication`);
	}
	run.endedAt = undefined;
	run.status = "running";
	const removal = traceFiles(() => saveRun(run));
	const checkpointRename = removal.findIndex((event) => event.kind === "rename" && event.to === metadata);
	const outputRemoval = removal.findIndex((event) => (event.kind === "remove" || event.kind === "unlink") && event.file === runOutputFile(run.id));
	assert.ok(outputRemoval > checkpointRename, "output was deleted before replacing the settled checkpoint");
	assert.ok(directorySyncedBetween(removal, checkpointRename, outputRemoval), "checkpoint unpublication was not durable before output deletion");
	assert.ok(directorySyncedBetween(removal, outputRemoval, removal.length), "output deletion was not directory-fsynced");
});

test("checkpoint temp fsync failure leaves the prior snapshot readable and retry repairs output", () => {
	const run = record();
	run.messages = [assistant("committed A")];
	run.endedAt = 200;
	run.status = "ok";
	saveRun(run);
	run.messages = [assistant("uncommitted B")];
	const { openSync, fsyncSync } = fs;
	let checkpointFd: number | undefined;
	const mocks = [
		mock.method(fs, "openSync", (file: any, ...args: any[]) => {
			const fd = (openSync as any)(file, ...args);
			if (String(file).startsWith(`${runFile(run.id)}.`) && String(file).endsWith(".tmp")) checkpointFd = fd;
			else if (fd === checkpointFd) checkpointFd = undefined;
			return fd;
		}),
		mock.method(fs, "fsyncSync", (fd: number) => {
			if (fd === checkpointFd) throw new Error("injected checkpoint fsync failure");
			return fsyncSync(fd);
		}),
	];
	syncBuiltinESMExports();
	try { assert.throws(() => saveRun(run), /injected checkpoint fsync/); }
	finally { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(loadRunById(run.id)?.finalOutput, "committed A");
	run.messages = [assistant("committed A")];
	saveRun(run);
	assert.equal(getRunOutputPage(run.id).text, "committed A");
});

test("settled output is written once and paged directly with strict UTF-8 byte boundaries", () => {
	const run = record();
	const text = "a😀é漢".repeat(4000);
	run.messages = [assistant(text)];
	run.endedAt = 200;
	run.status = "ok";
	saveRun(run);
	const output = runOutputFile(run.id);
	assert.equal(fs.readFileSync(output, "utf8"), text);
	const before = fs.statSync(output, { bigint: true });
	saveRun(run);
	const after = fs.statSync(output, { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.mtimeNs, before.mtimeNs);
	withoutJournalReads(() => {
		let offset: number | undefined = 0;
		let combined = "";
		while (offset !== undefined) {
			const page = getRunOutputPage(run.id, { offset, limit: 4096 });
			assert.equal(page.offset, offset);
			assert.equal(page.outputFile, output);
			assert.equal(page.totalBytes, Buffer.byteLength(text));
			assert.ok(Buffer.byteLength(page.text) <= 4096);
			assert.ok(!page.text.includes("�"));
			assert.ok(page.nextOffset === undefined || page.nextOffset > offset);
			combined += page.text;
			offset = page.nextOffset;
		}
		assert.equal(combined, text);
		assert.equal(getRunOutputPage(run.id, { offset: 1, limit: 4 }).text, "😀");
		assert.throws(() => getRunOutputPage(run.id, { offset: 2 }), /UTF-8/);
		assert.throws(() => getRunOutputPage(run.id, { offset: 1, limit: 1 }), /increase limit/);
		assert.deepEqual(getRunOutputPage(run.id, { offset: Buffer.byteLength(text) }), {
			text: "", offset: Buffer.byteLength(text), totalBytes: Buffer.byteLength(text), outputFile: output,
		});
		assert.throws(() => getRunOutputPage(run.id, { offset: Buffer.byteLength(text) + 1 }), /exceeds/);
	});
	for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => getRunOutputPage(run.id, { offset }), /offset/);
	for (const limit of [0, -1, 0.5, 16385, NaN, Infinity]) assert.throws(() => getRunOutputPage(run.id, { limit }), /limit/);
	assert.throws(() => runOutputFile("../../bad"), /Invalid run id/);
	assert.throws(() => getRunOutputPage("run-missing"), /not found/);
});

test("live and interrupted output reads never lock, mutate, or abort their writer", () => {
	for (const interrupted of [false, true]) {
		const run = record();
		if (interrupted) run.ownerPid = 2147483647;
		run.messages = [assistant("initial A")];
		saveRun(run);
		const file = journal(run);
		const read = fs.readFileSync;
		let advanced = false;
		const progress = mock.method(fs, "readFileSync", (target: any, ...args: any[]) => {
			if (String(target) === file && !advanced) {
				advanced = true;
				assert.ok(!fs.existsSync(`${runFile(run.id)}.lock`), "output readers must not exclude progress writers");
				run.messages.push(assistant("updated B"));
				saveRun(run); // A real progress save interleaved with the reader's replay.
			}
			return (read as any)(target, ...args);
		});
		syncBuiltinESMExports();
		try { assert.equal(getRunOutputPage(run.id).text, "updated B"); }
		finally { progress.mock.restore(); syncBuiltinESMExports(); }
		assert.ok(advanced);
		const committed = fs.readFileSync(runFile(run.id), "utf8");
		assert.equal(checkpoint(run).record.endedAt, undefined);
		assert.equal(getRunOutputPage(run.id).text, "updated B");
		assert.equal(fs.readFileSync(runFile(run.id), "utf8"), committed, "retrieval cannot rewrite checkpoint metadata");
		assert.ok(!fs.existsSync(runOutputFile(run.id)));
	}
});

test("continuously changing output snapshots stop after bounded nonmutating retries", () => {
	const run = record();
	run.messages = [assistant("initial")];
	saveRun(run);
	const file = journal(run);
	const read = fs.readFileSync;
	let changes = 0;
	const progress = mock.method(fs, "readFileSync", (target: any, ...args: any[]) => {
		if (String(target) === file) {
			run.messages = [assistant(`update-${++changes}`)];
			saveRun(run);
		}
		return (read as any)(target, ...args);
	});
	syncBuiltinESMExports();
	try { assert.throws(() => getRunOutputPage(run.id), /output changed while reading; retry/); }
	finally { progress.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(changes, 3);
	assert.equal(getRunOutputPage(run.id).text, "update-3");
});

test("JSON output files retain full parsed output; running and legacy retrieval explicitly falls back", () => {
	const run = record();
	run.messages = [assistant("provider prose")];
	run.parsedOutput = { answer: "😀".repeat(10000), valid: true };
	run.endedAt = 200;
	run.status = "ok";
	saveRun(run);
	assert.deepEqual(JSON.parse(fs.readFileSync(runOutputFile(run.id), "utf8")), run.parsedOutput);
	assert.equal(getRunOutputPage(run.id).totalBytes, Buffer.byteLength(JSON.stringify(run.parsedOutput, null, 2)));
	const old = record();
	old.messages = [assistant("legacy answer")];
	old.endedAt = 200;
	old.status = "ok";
	legacy(old);
	assert.equal(getRunOutputPage(old.id, { limit: 6 }).text, "legacy");
	withoutJournalReads(() => assert.equal(getRunOutputPage(old.id, { offset: 7 }).text, "answer"));
	const running = record();
	running.messages = [assistant("😀running")];
	saveRun(running);
	assert.equal(getRunOutputPage(running.id, { limit: 4 }).text, "😀");
	assert.equal(getRunOutputPage(running.id).outputFile, undefined);
	assert.ok(!fs.existsSync(runOutputFile(running.id)));
});

test("corrupt summary ids and identities changed under the prune lock cannot delete another run", { timeout: 30000 }, () => {
	for (const boundary of ["summary", "locked-identity"] as const) {
		fs.rmSync(RUNS_DIR, { recursive: true, force: true });
		const oldest = record("run-corrupt-oldest", 1);
		oldest.endedAt = 2;
		oldest.status = "ok";
		saveRun(oldest);
		const victim = record("run-corrupt-victim", 2);
		victim.messages = [assistant("victim")];
		saveRun(victim);
		fs.writeFileSync(runOutputFile(victim.id), "victim output");
		const victimFiles = [runFile(victim.id), journal(victim), runOutputFile(victim.id), path.join(RUNS_DIR, checkpoint(victim).taskFile)];
		const protectedBytes = victimFiles.map((file) => fs.readFileSync(file));
		if (boundary === "summary") {
			const corrupt = checkpoint(oldest);
			corrupt.summary.id = victim.id;
			fs.writeFileSync(runFile(oldest.id), JSON.stringify(corrupt));
		}
		for (let i = 0; i < 199; i++) {
			const run = record(`run-corrupt-fill-${i}`, i + 10);
			run.status = "ok";
			run.endedAt = run.startedAt + 1;
			saveRun(run);
		}
		const read = fs.readFileSync;
		let tampered = false;
		const race = mock.method(fs, "readFileSync", (file: any, ...args: any[]) => {
			if (boundary === "locked-identity" && String(file) === runFile(oldest.id) && fs.existsSync(`${runFile(oldest.id)}.lock`) && !tampered) {
				tampered = true;
				const corrupt = JSON.parse(read(file, "utf8"));
				corrupt.record.id = victim.id;
				corrupt.summary.id = victim.id;
				corrupt.taskFile = checkpoint(victim).taskFile;
				corrupt.journal.file = checkpoint(victim).journal.file;
				fs.writeFileSync(file, JSON.stringify(corrupt));
			}
			return (read as any)(file, ...args);
		});
		syncBuiltinESMExports();
		const trigger = record("run-corrupt-trigger", 1000);
		trigger.endedAt = 1001;
		trigger.status = "ok";
		try { saveRun(trigger); }
		finally { race.mock.restore(); syncBuiltinESMExports(); }
		if (boundary === "locked-identity") assert.ok(tampered, "prune did not reach the locked reread");
		for (const [index, file] of victimFiles.entries()) assert.deepEqual(fs.readFileSync(file), protectedBytes[index], `${boundary}: victim file changed: ${file}`);
		assert.ok(fs.existsSync(runFile(oldest.id)), "corrupt candidate was not rejected");
		assert.equal(loadRunById(oldest.id), null);
		assert.ok(!listRuns(1000).some((run) => run.file === runFile(oldest.id)));
		assert.throws(() => saveRun(oldest), /checkpoint/i);
	}
});

test("pruning coordinates checkpoints, journals, output/task files, busy writers, and protects v2 snapshots", { timeout: 20000 }, () => {
	const old = record("run-legacy", 1);
	old.endedAt = 2;
	old.status = "ok";
	const oldFile = legacy(old);
	const legacyBytes = fs.readFileSync(oldFile);
	const records: RunRecord[] = [];
	for (let i = 0; i < 202; i++) {
		const run = record(`run-prune-${String(i).padStart(3, "0")}`, i + 10);
		run.status = "ok";
		run.endedAt = run.startedAt + 1;
		if (i === 0) {
			// Keep a per-run lock held while other completed runs trigger pruning.
			saveRun(run);
			fs.mkdirSync(`${runFile(run.id)}.lock`);
		} else saveRun(run);
		records.push(run);
	}
	assert.ok(fs.existsSync(runFile(records[0].id)), "busy writer was pruned");
	fs.rmdirSync(`${runFile(records[0].id)}.lock`);
	const events = traceFiles(() => saveRun(records.at(-1)!));
	const unpublish = events.findIndex((event) => event.kind === "unlink" && event.file === runFile(records[0].id));
	const deletions = events.flatMap((event, index) => event.kind === "remove" && event.file.startsWith(path.join(RUNS_DIR, `${records[0].id}.`)) ? [index] : []);
	assert.ok(unpublish >= 0 && deletions.length >= 3);
	assert.ok(directorySyncedBetween(events, unpublish, deletions[0]), "prune deleted dependencies before checkpoint removal was durable");
	assert.ok(directorySyncedBetween(events, deletions.at(-1)!, events.length), "prune did not persist dependency deletion");
	for (const run of records.slice(0, 2)) {
		assert.ok(!fs.existsSync(runFile(run.id)));
		assert.ok(!fs.existsSync(runOutputFile(run.id)));
		assert.ok(!fs.readdirSync(RUNS_DIR).some((name) => name.startsWith(`${run.id}.`) && (name.endsWith(".jsonl") || name.endsWith(".task.txt"))));
	}
	assert.equal(listRuns(1000).filter((r) => r.id.startsWith("run-prune-")).length, 200);
	assert.deepEqual(fs.readFileSync(oldFile), legacyBytes);
	assert.ok(listRuns(1000).some((r) => r.id === old.id));
	assert.ok(loadRunById(records.at(-1)!.id));
});
