import { agent, defaults, temp } from "./setup.ts";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VerificationCollector } from "../src/verification.ts";
import { Runner } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";
import { loadRunById, ARTIFACTS_DIR } from "../src/store.ts";

const collector = (attempt = 1, runId = "run-verification-unit") => new VerificationCollector({
	runId, attempt, artifactDir: path.join(temp, "verification-artifacts"), cwd: temp,
});
const start = (id: string, command = "npm test", parent?: string) => ({ type: "tool_execution_start", toolName: "bash",
	toolCallId: id, args: { command }, parentToolCallId: parent });
const end = (id: string, result: unknown = { content: [{ type: "text", text: "done" }] }, isError = false, parent?: string) =>
	({ type: "tool_execution_end", toolName: "bash", toolCallId: id, parentToolCallId: parent, result, isError });
const callMessage = (id: string, command = "npm test", timestamp = 1) => ({ role: "assistant", timestamp,
	content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] });
const resultMessage = (id: string, text = "done", details?: unknown, isError = false, timestamp = 2) => ({
	role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], details, isError, timestamp,
});
const peer = fileURLToPath(new URL("./fixtures/verification-peer.mjs", import.meta.url));
const runnerFor = (scenario: string, scheduler = new Scheduler()) => new Runner({ scheduler,
	invocation: { command: process.execPath, prefix: [peer, scenario] }, killGraceMs: 60 });

function persisted(runId: string) {
	const run = loadRunById(runId)!;
	const manifest = JSON.parse(fs.readFileSync(run.artifacts!.manifest!, "utf8"));
	assert.deepEqual(manifest.verification, run.artifacts!.verification);
	assert.deepEqual(run.artifacts!.verification, run.attemptHistory!.flatMap((attempt) => attempt.verification ?? []));
	return run.artifacts!.verification;
}

test("arbitrary nested/concurrent calls and duplicate events retain exact identity without nestedCalls metadata", () => {
	const c = collector();
	for (let i = 0; i < 300; i++) {
		const event = start(`root/${i}/1`, `check ${i}`, `root/${i}`);
		c.observeEvent(event);
		c.observeEvent(event);
	}
	for (let i = 299; i >= 0; i--) {
		const event = end(`root/${i}/1`, { structuredContent: { output: `output ${i}`, exit_code: i === 42 ? 7 : 0 } }, i === 42, `root/${i}`);
		c.observeEvent(event);
		c.observeEvent(event);
	}
	// Parent identity is explicit, not guessed by parsing IDs or by call order.
	c.observeEvent(start("same-id", "other parent", "different"));
	c.observeEvent(start("same-id", "third parent", "another"));
	assert.equal(c.evidence.length, 302);
	assert.equal(c.evidence[42].command, "check 42");
	assert.equal(c.evidence[42].outcome, "error");
	assert.equal(c.evidence[42].exitCode, 7);
	assert.equal(c.evidence[42].parentToolCallId, "root/42");
	assert.equal(c.evidence[0].output, "output 0");
	assert.equal(c.evidence[300].outcome, "incomplete");
	assert.ok(c.evidence.every((entry) => entry.runId === "run-verification-unit" && entry.attempt === 1));
});

test("only reported integer exit codes are evidence; missing ends never certify success", () => {
	const c = collector();
	c.observeEvent(start("success-unknown"));
	c.observeEvent(end("success-unknown"));
	c.observeEvent(start("error-unknown"));
	c.observeEvent(end("error-unknown", {}, true));
	c.observeEvent(start("cancel"));
	c.observeEvent(end("cancel", { content: [{ type: "text", text: "partial\n\nCommand aborted" }] }, true));
	c.observeEvent(start("unfinished"));
	c.observeEvent({ ...start("unfinished"), type: "tool_execution_update", partialResult: {
		content: [{ type: "text", text: "still running" }], details: { exitCode: 0 },
	} });
	for (const exitCode of [NaN, Infinity, 0.5, "0"]) c.observeEvent(end(`invalid-${String(exitCode)}`, { details: { exitCode } }));
	c.finish("ok");
	assert.deepEqual(c.evidence.slice(0, 4).map((entry) => entry.outcome), ["completed", "error", "cancelled", "incomplete"]);
	assert.ok(c.evidence.every((entry) => entry.exitCode === undefined));
	assert.equal(c.evidence[3].output, "still running");
	assert.equal(c.evidence[3].endObserved, false);
	c.finish("timeout");
	assert.equal(c.evidence[3].outcome, "cancelled");
	assert.equal(c.evidence[3].endObserved, false);
});

test("direct transcript fallback reconciles events, lost ends, copied resumes, and reused IDs per attempt", () => {
	const c = collector();
	c.observeMessage(callMessage("both"));
	c.observeEvent(start("both"));
	c.observeEvent(end("both", { structuredContent: { output: "richer event output", exit_code: 7 } }, true));
	c.observeMessage(resultMessage("both", "clipped transcript"));
	c.observeMessage(resultMessage("both", "clipped transcript"));
	c.observeEvent(start("lost"));
	c.observeMessage(resultMessage("lost", "recovered result", { exitCode: 3 }, true));
	c.observeMessage(callMessage("transcript-only"));
	c.observeMessage(resultMessage("transcript-only"));
	c.observeMessage(callMessage("no-result"));
	c.finish("ok");
	assert.equal(c.evidence.length, 4);
	assert.equal(c.evidence[0].output, "richer event output");
	assert.equal(c.evidence[0].outcome, "error");
	assert.equal(c.evidence[0].exitCode, 7);
	assert.equal(c.evidence[0].source, "event+transcript");
	assert.equal(c.evidence[1].endObserved, false);
	assert.equal(c.evidence[1].resultObserved, true);
	assert.equal(c.evidence[1].exitCode, 3);
	assert.equal(c.evidence[2].exitCode, undefined);
	assert.equal(c.evidence[3].outcome, "incomplete");
	const second = collector(2);
	second.observeMessage(callMessage("both", "new command"));
	second.observeMessage(resultMessage("both", "new output", { exitCode: 0 }));
	assert.equal(second.evidence[0].attempt, 2);
	assert.equal(second.evidence[0].command, "new command");
	const resumed = new VerificationCollector({ runId: "run-resumed", attempt: 1, cwd: temp, artifactDir: ARTIFACTS_DIR,
		historicalMessages: [callMessage("both"), resultMessage("both")] });
	resumed.observeMessage(callMessage("both"));
	resumed.observeMessage(resultMessage("both"));
	assert.equal(resumed.evidence.length, 0);
	resumed.observeMessage(callMessage("both", "new command", 3));
	resumed.observeMessage(resultMessage("both", "new output", undefined, false, 4));
	assert.equal(resumed.evidence.length, 1);
	assert.equal(resumed.evidence[0].runId, "run-resumed");
});

test("large output has UTF-8 bounded excerpts and stable full artifacts after hydration and temp deletion", () => {
	const c = collector();
	const output = "日本語 🎉\n".repeat(4000);
	const original = path.join(temp, "upstream-output.txt");
	fs.writeFileSync(original, output);
	c.observeEvent(start("large", "large output", "wrapper"));
	c.observeEvent(end("large", { content: [{ type: "text", text: output.slice(-100) }],
		details: { truncation: { truncated: true }, fullOutputPath: original } }, false, "wrapper"));
	c.observeEvent(start("structured"));
	c.observeEvent(end("structured", { content: [{ type: "text", text: "model excerpt" }],
		structuredContent: { output, truncated: false, exit_code: 0 }, details: { truncation: { truncated: true } } }));
	fs.rmSync(original);
	for (const entry of c.evidence) {
		assert.ok(Buffer.byteLength(entry.output) <= 8192);
		assert.ok(!entry.output.includes("�"));
		assert.notEqual(entry.fullOutputPath, original);
		assert.equal(fs.readFileSync(entry.fullOutputPath!, "utf8"), output);
		assert.equal(entry.fullOutputComplete, true);
		assert.equal(entry.outputTruncated, true);
	}
	const saved = JSON.parse(JSON.stringify(c.evidence));
	const recovered = new VerificationCollector({ runId: "run-verification-unit", attempt: 1, cwd: temp,
		artifactDir: ARTIFACTS_DIR, evidence: saved });
	recovered.observeEvent(end("large", { content: [{ type: "text", text: "duplicate" }] }, false, "wrapper"));
	assert.deepEqual(recovered.evidence, c.evidence);
	const missing = collector(3);
	missing.observeEvent(end("missing", { content: [{ type: "text", text: "truncated" }],
		details: { truncation: { truncated: true }, fullOutputPath: original } }));
	assert.equal(missing.evidence[0].fullOutputComplete, false);
	assert.match(missing.evidence[0].outputError!, /unavailable/);
	assert.equal(fs.readFileSync(missing.evidence[0].fullOutputPath!, "utf8"), "truncated");
});

test("aborted tail-only ends retain earlier full-output provenance and the last good artifact", () => {
	for (const keepSource of [true, false]) {
		const c = collector(keepSource ? 10 : 11);
		const original = path.join(temp, `abort-source-${keepSource}.txt`);
		const initial = "EARLY-SENTINEL\n" + "x".repeat(9 * 1024);
		const final = initial + "\nFINAL-SENTINEL\n";
		fs.writeFileSync(original, initial);
		c.observeEvent(start("aborted-source"));
		c.observeEvent({ ...start("aborted-source"), type: "tool_execution_update", partialResult: {
			content: [{ type: "text", text: "truncated progress tail" }],
			details: { truncation: { truncated: true }, fullOutputPath: original },
		} });
		const artifact = c.evidence[0].fullOutputPath!;
		assert.equal(fs.readFileSync(artifact, "utf8"), initial);
		assert.equal(c.evidence[0].fullOutputComplete, false);
		// Provenance survives hydration before the terminal frame as well.
		const hydrated = new VerificationCollector({ runId: "run-verification-unit", attempt: keepSource ? 10 : 11,
			artifactDir: path.join(temp, "verification-artifacts"), cwd: temp, evidence: JSON.parse(JSON.stringify(c.evidence)) });
		if (keepSource) fs.writeFileSync(original, final);
		else fs.rmSync(original);
		hydrated.observeEvent(end("aborted-source", { content: [{ type: "text", text: "last tail\n\nCommand aborted" }] }, true));
		hydrated.finish("timeout");
		const evidence = hydrated.evidence[0];
		assert.equal(evidence.outcome, "cancelled");
		assert.equal(evidence.exitCode, undefined);
		assert.equal(evidence.outputTruncated, true, "loss of end details must not erase upstream truncation");
		assert.equal(evidence.fullOutputPath, artifact);
		assert.equal(evidence.fullOutputComplete, false, "an aborted tail cannot certify a complete output");
		assert.equal(fs.readFileSync(artifact, "utf8"), keepSource ? final : initial);
		assert.match(fs.readFileSync(artifact, "utf8"), /^EARLY-SENTINEL/);
		if (!keepSource) assert.match(evidence.outputError!, /unavailable/);
	}
});

test("growing full-output sources are copied once during progress and refreshed at terminal/unfinished finalization", () => {
	for (const terminal of [true, false]) {
		const c = collector(terminal ? 12 : 13);
		const original = path.join(temp, `growing-source-${terminal}.txt`);
		let output = "EARLY-SENTINEL\n";
		fs.writeFileSync(original, output);
		c.observeEvent(start("growing"));
		const copy = fs.copyFileSync;
		let copies = 0;
		const spy = mock.method(fs, "copyFileSync", (...args: Parameters<typeof fs.copyFileSync>) => { copies++; return copy(...args); });
		syncBuiltinESMExports();
		try {
			for (let i = 0; i < 100; i++) {
				output += "x".repeat(1024);
				fs.writeFileSync(original, output);
				c.observeEvent({ ...start("growing"), type: "tool_execution_update", partialResult: {
					content: [{ type: "text", text: `tail-${i}` }], details: { fullOutputPath: original, truncation: { truncated: true } },
				} });
			}
			assert.equal(copies, 1, "progress must not recopy an ever-growing output on every update");
			if (terminal) c.observeEvent(end("growing", { content: [{ type: "text", text: "terminal tail" }],
				details: { fullOutputPath: original, truncation: { truncated: true }, exitCode: 0 } }));
			c.finish(terminal ? "ok" : "interrupted");
			assert.equal(copies, 2, "capture the final available source, even if the end frame was lost");
		} finally { spy.mock.restore(); syncBuiltinESMExports(); }
		assert.equal(fs.readFileSync(c.evidence[0].fullOutputPath!, "utf8"), output);
		assert.equal(c.evidence[0].fullOutputComplete, terminal);
		assert.equal(c.evidence[0].endObserved, terminal);
		assert.equal(c.evidence[0].outcome, terminal ? "completed" : "incomplete");
		assert.equal(c.evidence[0].exitCode, terminal ? 0 : undefined);
	}
});

test("verification filesystem failures are evidence warnings, never thrown or fabricated artifacts", () => {
	for (const operation of ["mkdirSync", "writeFileSync", "renameSync"] as const) {
		const c = collector(20 + ["mkdirSync", "writeFileSync", "renameSync"].indexOf(operation));
		const fail = mock.method(fs, operation, () => { throw Object.assign(new Error(`injected ${operation} EACCES`), { code: "EACCES" }); });
		syncBuiltinESMExports();
		try {
			assert.doesNotThrow(() => c.observeEvent(end(`failure-${operation}`, {
				structuredContent: { output: "x".repeat(9 * 1024), truncated: false, exit_code: 0 },
			})));
		} finally { fail.mock.restore(); syncBuiltinESMExports(); }
		assert.match(c.evidence[0].outputError!, new RegExp(`injected ${operation} EACCES`));
		assert.equal(c.evidence[0].fullOutputPath, undefined);
		assert.notEqual(c.evidence[0].fullOutputComplete, true);
		assert.equal(c.evidence[0].endObserved, true);
		assert.equal(c.evidence[0].exitCode, 0);
	}
});

test("concurrent subprocess evidence survives storage/manifests and a fresh-process replay without duplicates", { timeout: 15000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 2 });
	const runner = runnerFor("mixed", scheduler);
	const runs = await Promise.all([runner.run(defaults, agent, "first"), runner.run(defaults, agent, "second")]);
	for (const run of runs) {
		assert.equal(run.status, "ok", run.errorMessage);
		const evidence = persisted(run.id);
		assert.equal(evidence.length, 3);
		assert.deepEqual(evidence.map((entry) => entry.outcome), ["completed", "error", "incomplete"]);
		assert.equal(evidence[0].exitCode, undefined);
		assert.equal(evidence[1].exitCode, 7);
		assert.equal(evidence[1].parentToolCallId, "wrap/1/1");
		assert.equal(evidence[1].toolCallId, "wrap/1/1/1");
		assert.ok(fs.readFileSync(evidence[1].fullOutputPath!, "utf8").length > 8192);
		assert.ok(evidence.every((entry) => entry.runId === run.id && entry.attempt === 1));
		const replay = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/verification-restart.ts", import.meta.url)), run.id],
			{ encoding: "utf8", env: process.env, timeout: 5000 });
		assert.equal(replay.status, 0, replay.stderr);
		assert.deepEqual(JSON.parse(replay.stdout), evidence);
		assert.equal(run.usage.cost, 0.02);
	}
	assert.equal((await scheduler.snapshot()).leases.length, 0);
});

test("session fallback recovers terminal direct results after RPC loss, including a worker crash", { timeout: 10000 }, async () => {
	for (const scenario of ["fallback", "fallback-crash"]) {
		const run = await runnerFor(scenario).run(defaults, agent, "lost frames");
		assert.equal(run.status, scenario === "fallback" ? "ok" : "error", run.errorMessage);
		const evidence = persisted(run.id);
		assert.equal(evidence.length, 2);
		assert.equal(evidence[0].command, "printf 'old direct'");
		assert.equal(evidence[0].outcome, "error");
		assert.equal(evidence[0].exitCode, 3);
		assert.equal(evidence[0].endObserved, false);
		assert.equal(evidence[0].resultObserved, true);
		assert.equal(evidence[0].output, "direct complete");
		assert.equal(evidence[1].outcome, "incomplete");
	}
});

test("interrupted and cancelled subprocess starts cannot become successful evidence", { timeout: 10000 }, async () => {
	const crashed = await runnerFor("interrupted").run(defaults, agent, "interrupt");
	assert.equal(crashed.status, "error");
	assert.ok(persisted(crashed.id).every((entry) => entry.outcome === "incomplete" && entry.exitCode === undefined));
	assert.equal(crashed.artifacts!.verification[1].output, "partial nested output");
	const controller = new AbortController();
	const runner = runnerFor("cancel");
	const cancelled = await runner.run(defaults, agent, "cancel", { timeoutSeconds: 5 }, undefined, controller.signal, (record) => {
		if (record.attemptHistory?.[0].verification?.some((entry) => entry.toolCallId === "wrap/1/1/1")) controller.abort();
	});
	assert.equal(cancelled.status, "aborted");
	assert.ok(persisted(cancelled.id).every((entry) => entry.outcome === "cancelled" && entry.exitCode === undefined && !entry.endObserved));
	assert.equal((await runner.scheduler.snapshot()).leases.length, 0);
});

test("retries and copied resumes never merge evidence for reused tool IDs", { timeout: 10000 }, async () => {
	const runner = runnerFor("mixed");
	const original = await runner.run(defaults, agent, "original", { retries: 1, outputFormat: "json" });
	assert.equal(original.attempts, 2);
	const evidence = persisted(original.id);
	assert.equal(evidence.length, 6);
	assert.deepEqual(evidence.map((entry) => entry.attempt), [1, 1, 1, 2, 2, 2]);
	const source = fs.readFileSync(original.sessionFile!);
	const resumed = await runner.run(defaults, agent, "continuation", { resumeFrom: original });
	assert.equal(resumed.status, "ok", resumed.errorMessage);
	const newEvidence = persisted(resumed.id);
	assert.equal(newEvidence.length, 3);
	assert.ok(newEvidence.every((entry) => entry.runId === resumed.id && entry.attempt === 1));
	assert.equal(newEvidence[0].command, "printf 'new direct'");
	assert.deepEqual(fs.readFileSync(original.sessionFile!), source);
	assert.equal(resumed.usage.cost, 0.02);
});

test("real offline pi captures a failing bash command nested through arbitrary wrappers despite a successful outer result", { timeout: 20000 }, async () => {
	const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
	const provider = fileURLToPath(new URL("./fixtures/verification-provider.ts", import.meta.url));
	const runner = new Runner({ invocation: { command: process.execPath, prefix: [cli, "--extension", provider] }, killGraceMs: 1000 });
	const run = await runner.run(defaults, { ...agent, tools: ["bash", "verification_wrap"], model: "verification-fixture/local" },
		"verify offline", { timeoutSeconds: 15 });
	assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
	const evidence = persisted(run.id);
	assert.equal(evidence.length, 2);
	const nested = evidence.find((entry) => entry.parentToolCallId)!;
	assert.equal(nested.toolCallId, "wrapped/1/1/1");
	assert.equal(nested.parentToolCallId, "wrapped/1/1");
	assert.equal(nested.command, "printf 'NESTED-FAILED\\n'; exit 7");
	assert.equal(nested.outcome, "error");
	assert.equal(nested.exitCode, 7);
	assert.match(nested.output, /NESTED-FAILED/);
	assert.equal(nested.source, "event");
	const direct = evidence.find((entry) => entry.toolCallId === "direct")!;
	assert.equal(direct.exitCode, 0);
	assert.equal(direct.source, "event+transcript");
	const results = run.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 2, "nested results are absent from the direct transcript");
	assert.ok(results.every((message) => !message.isError));
	assert.equal(run.usage.cost, 0.02);
	assert.equal((await runner.scheduler.snapshot()).leases.length, 0);
});
