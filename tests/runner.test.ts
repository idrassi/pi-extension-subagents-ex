import { agent, defaults } from "./setup.ts";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Runner, type RunnerEvent, type RunnerOptions } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";
import { getFinalOutput } from "../src/format.ts";
import { VerificationCollector } from "../src/verification.ts";
import { loadRunById } from "../src/store.ts";

const runnerFor = (scenario: string, options: RunnerOptions = {}) =>
	new Runner({
		scheduler: new Scheduler(),
		invocation: {
			command: process.execPath,
			prefix: [fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), scenario],
		},
		killGraceMs: 60,
		...options,
	});

test("RPC recovery clears transient errors, ignores intermediate agent_end, and preserves diagnostics", async () => {
	const run = await runnerFor("recovered").run(defaults, agent, "test");
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(run.errorMessage, undefined);
	assert.equal(getFinalOutput(run.messages), "recovered");
	assert.deepEqual(run.attemptHistory?.[0].diagnostics, ["transient failure"]);
	assert.equal(run.usage.turns, 2);
	assert.ok(Math.abs(run.usage.cost - 0.3) < 1e-9);
});

test("streaming checkpoints and observers coalesce bursts but settlement retains every message", { timeout: 15000 }, async () => {
	const runner = runnerFor("message-burst");
	let updates = 0;
	const run = await runner.run(defaults, agent, "test", {}, undefined, undefined, () => { updates++; });
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(run.messages.length, 100);
	assert.equal(loadRunById(run.id)?.messages.length, 100);
	assert.ok(updates < 80, `expected fewer observers than messages, got ${updates}`);
	assert.equal(fs.readFileSync(run.artifacts!.output!, "utf8"), "message-99");
	const settledUpdates = updates;
	await delay(160);
	assert.equal(updates, settledUpdates, "no delayed progress snapshot after settlement");
	assert.deepEqual((await runner.scheduler.snapshot()).leases, []);
});

test("schema retries retain each transcript and all billed usage", async () => {
	const run = await runnerFor("retry").run(defaults, agent, "answer", {
		retries: 1,
		outputSchema: {
			type: "object",
			properties: { answer: { type: "number" } },
			required: ["answer"],
			additionalProperties: false,
		},
	});
	assert.equal(run.status, "ok", run.errorMessage);
	assert.deepEqual(run.parsedOutput, { answer: 42 });
	assert.equal(run.attempts, 2);
	assert.equal(run.attemptHistory?.[0].status, "error");
	assert.equal(run.attemptHistory?.[1].status, "ok");
	assert.equal(run.usage.input, 30);
	assert.ok(Math.abs(run.usage.cost - 0.3) < 1e-9);
	assert.deepEqual(loadRunById(run.id)?.attemptHistory, JSON.parse(JSON.stringify(run.attemptHistory)));
});

test("nested tool usage is billed once in the run and excluded from direct tree reporting", async () => {
	const runner = runnerFor("nested");
	const run = await runner.run(defaults, agent, "test");
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(run.usage.input, 60);
	assert.ok(Math.abs(run.usage.cost - 0.6) < 1e-9);
	assert.equal((await runner.scheduler.snapshot()).cost, 0.2);
});

test("session-only usage is reconciled into run and shared budget", async () => {
	const runner = runnerFor("extra-stats");
	const run = await runner.run(defaults, agent, "test");
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(run.usage.input, 40);
	assert.equal(run.usage.cost, 0.4);
	assert.equal((await runner.scheduler.snapshot()).cost, 0.4);
});

test("UTF-8 survives split frames; large prompts are transported over stdin", async () => {
	const utf8 = await runnerFor("utf8").run(defaults, agent, "test");
	assert.equal(utf8.status, "ok", utf8.errorMessage);
	assert.equal(getFinalOutput(utf8.messages), "日本語 🎉");
	const large = await runnerFor("large").run(defaults, agent, "x".repeat(300_000));
	assert.equal(large.status, "ok", large.errorMessage);
	assert.equal(Number(getFinalOutput(large.messages)), 300_006);
});

test("SIGTERM-resistant child is killed and its scheduler slot is released", async () => {
	const runner = runnerFor("hang");
	const start = Date.now();
	const run = await runner.run(defaults, agent, "test", { timeoutSeconds: 0.25 });
	assert.equal(run.status, "timeout", run.errorMessage);
	assert.ok(Date.now() - start < 2000);
	assert.equal((await runner.scheduler.snapshot()).leases.length, 0);
	assert.throws(() => process.kill(run.childPid!, 0), /ESRCH/);
});

test("stall watchdog kills idle workers, retains usage, and does not retry timeouts", { timeout: 5000 }, async () => {
	const runner = runnerFor("hang", { stallTimeoutMs: 200 });
	const run = await runner.run(defaults, agent, "test", { retries: 3 });
	assert.equal(run.status, "timeout", run.errorMessage);
	assert.match(run.errorMessage!, /stall timeout/);
	assert.equal(run.attempts, 1);
	assert.equal(run.usage.cost, 0.1);
	assert.equal((await runner.scheduler.snapshot()).cost, 0.1);
	assert.equal((await runner.scheduler.snapshot()).leases.length, 0);
	assert.throws(() => process.kill(run.childPid!, 0), /ESRCH/);
});

test("model streaming and tool updates let workers outlive a stall window", { timeout: 5000 }, async () => {
	for (const scenario of ["stream-progress", "tool-progress"]) {
		const run = await runnerFor(scenario, { stallTimeoutMs: 500 }).run(defaults, agent, "test");
		assert.equal(run.status, "ok", `${scenario}: ${run.errorMessage}`);
	}
});

test("explicit elapsed deadline still stops a worker that is making progress", { timeout: 5000 }, async () => {
	const run = await runnerFor("stream-progress", { stallTimeoutMs: 500 }).run(defaults, agent, "test", {
		timeoutSeconds: 0.5,
	});
	assert.equal(run.status, "timeout", run.errorMessage);
	assert.match(run.errorMessage!, /Timed out after 0.5s/);
});

test("stderr and unrelated RPC responses do not reset the stall watchdog", { timeout: 5000 }, async () => {
	const run = await runnerFor("noise", { stallTimeoutMs: 300 }).run(defaults, agent, "test");
	assert.equal(run.status, "timeout", run.errorMessage);
	assert.match(run.errorMessage!, /stall timeout/);
	assert.match(run.stderr, /still alive/);
});

test("stall time excludes admission queueing", { timeout: 5000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1 });
	const release = await scheduler.acquire("blocking-worker");
	const runner = runnerFor("complete", { scheduler, stallTimeoutMs: 300 });
	const pending = runner.run(defaults, agent, "test");
	try {
		await delay(650);
		assert.equal(runner.activeRunIds().length, 0);
	} finally {
		await release();
	}
	const run = await pending;
	assert.equal(run.status, "ok", run.errorMessage);
});

test("waiting parents defer stall detection to descendants and rearm it on return", { timeout: 5000 }, async () => {
	for (const scenario of ["delegate-wait", "collection-wait", "delegate-then-hang"]) {
		const run = await runnerFor(scenario, { stallTimeoutMs: 500 }).run(defaults, agent, "test");
		assert.equal(run.status, scenario === "delegate-then-hang" ? "timeout" : "ok", `${scenario}: ${run.errorMessage}`);
		if (scenario === "delegate-then-hang") assert.match(run.errorMessage!, /stall timeout/);
	}
});

test("stall timeout is configurable through the environment and rejects invalid values", { timeout: 5000 }, async (t) => {
	t.after(() => {
		delete process.env.PI_SUBAGENTS_EX_STALL_TIMEOUT_MS;
	});
	for (const value of ["0", "-1", "0.5", "Infinity", "NaN", "2147483648"]) {
		process.env.PI_SUBAGENTS_EX_STALL_TIMEOUT_MS = value;
		assert.throws(() => new Runner(), /PI_SUBAGENTS_EX_STALL_TIMEOUT_MS/);
	}
	process.env.PI_SUBAGENTS_EX_STALL_TIMEOUT_MS = "200";
	const run = await runnerFor("hang").run(defaults, agent, "test");
	assert.equal(run.status, "timeout", run.errorMessage);
	assert.match(run.errorMessage!, /0.2s \(stall timeout\)/);
});

test("pre-aborted requests spawn no child, and missing guard fails before prompting", async () => {
	const signal = AbortSignal.abort();
	const run = await runnerFor("hang").run(defaults, agent, "test", {}, undefined, signal);
	assert.equal(run.status, "aborted");
	assert.equal(run.childPid, undefined);
	const missing = await runnerFor("no-guard").run(defaults, agent, "test");
	assert.equal(missing.status, "error");
	assert.match(missing.errorMessage!, /guard did not load/);
});

test("unexpected exit and malformed RPC are explicit errors", async () => {
	for (const scenario of ["exit", "invalid-frame"]) {
		const run = await runnerFor(scenario).run(defaults, agent, "test");
		assert.equal(run.status, "error");
		assert.ok(run.errorMessage);
	}
});

test("a child hanging after settlement is bounded and reports forced cleanup", async () => {
	const run = await runnerFor("linger").run(defaults, agent, "test");
	assert.equal(run.status, "error");
	assert.match(run.errorMessage!, /forced termination/);
	assert.throws(() => process.kill(run.childPid!, 0), /ESRCH/);
});

test("steering reaches the active RPC worker", async () => {
	const runner = runnerFor("steer");
	const pending = runner.run(defaults, agent, "test", { timeoutSeconds: 5 });
	for (let i = 0; !runner.activeRunIds().length && i < 100; i++) await delay(10);
	await runner.steer(runner.activeRunIds()[0], "use the revised criteria");
	const run = await pending;
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(getFinalOutput(run.messages), "steered: use the revised criteria");
	assert.equal(runner.activeRunIds().length, 0);
});

test("resuming copies session history and charges only the new work", async () => {
	const runner = runnerFor("resume");
	const first = await runner.run(defaults, agent, "first");
	const original = fs.readFileSync(first.sessionFile!, "utf8");
	const second = await runner.run(defaults, agent, "continue", { resumeFrom: first });
	assert.equal(second.status, "ok", second.errorMessage);
	assert.equal(second.resumeOf, first.id);
	assert.equal(getFinalOutput(second.messages), "history=1");
	assert.equal(second.usage.cost, 0.1);
	assert.equal(fs.readFileSync(first.sessionFile!, "utf8"), original);
});

const telemetryRunner = (scenario: string, options: RunnerOptions = {}) => new Runner({
	invocation: { command: process.execPath,
		prefix: [fileURLToPath(new URL("./fixtures/verification-peer.mjs", import.meta.url)), scenario] },
	killGraceMs: 100,
	...options,
});

test("evidence publication EACCES never loses session-only or live usage/messages", { timeout: 15000 }, async () => {
	for (const scenario of ["accounting-session-crash", "accounting-live", "accounting-live-event"]) {
		const runner = telemetryRunner(scenario, { onEvent: async () => { throw new Error("observational rejection"); } });
		const rename = fs.renameSync;
		let failures = 0;
		const fail = mock.method(fs, "renameSync", (from: any, to: any) => {
			if (failures === 0 && /-bash-.*\.txt$/.test(String(to))) {
				failures++;
				throw Object.assign(new Error("injected verification EACCES"), { code: "EACCES" });
			}
			return rename(from, to);
		});
		syncBuiltinESMExports();
		let run;
		try {
			run = await runner.run(defaults, agent, "accounting despite evidence failure", {}, undefined, undefined,
				() => { throw new Error("presentation observer failed"); });
		} finally { fail.mock.restore(); syncBuiltinESMExports(); }
		assert.equal(failures, 1, scenario);
		assert.equal(run.status, scenario === "accounting-session-crash" ? "error" : "ok", run.errorMessage);
		assert.equal(run.messages.length, 3, `${scenario}: later messages must survive`);
		assert.equal(getFinalOutput(run.messages), "accounted after evidence failure");
		assert.ok(Math.abs(run.usage.cost - 0.03) < 1e-9, `${scenario}: run cost ${run.usage.cost}`);
		const saved = loadRunById(run.id)!;
		assert.deepEqual(saved.messages, run.messages);
		assert.equal(saved.usage.cost, run.usage.cost);
		const evidence = saved.attemptHistory![0].verification![0];
		assert.match(evidence.outputError!, /injected verification EACCES/);
		assert.equal(evidence.fullOutputPath, undefined, "a failed publication is not an artifact");
		assert.notEqual(evidence.fullOutputComplete, true);
		assert.equal(evidence.exitCode, 0, "the actually observed terminal result remains evidence");
		assert.deepEqual(saved.artifacts!.verification, [evidence]);
		assert.deepEqual(JSON.parse(fs.readFileSync(saved.artifacts!.manifest!, "utf8")).verification, [evidence]);
		const snapshot = await runner.scheduler.snapshot();
		assert.ok(Math.abs(snapshot.cost - 0.03) < 1e-9, `${scenario}: tree cost ${snapshot.cost}`);
		assert.deepEqual(snapshot.leases, []);
	}
});

test("unexpected evidence observers do not skip live accounting and rejected recovery scans can retry", { timeout: 10000 }, async () => {
	const observe = VerificationCollector.prototype.observeMessage;
	let failures = 0;
	const fail = mock.method(VerificationCollector.prototype, "observeMessage", function (this: VerificationCollector, message: any) {
		if (message.role === "toolResult" && failures++ === 0) throw new Error("injected evidence observer failure");
		return observe.call(this, message);
	});
	const live = telemetryRunner("accounting-live");
	let run;
	try { run = await live.run(defaults, agent, "observer failure"); } finally { fail.mock.restore(); }
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(run.messages.length, 3);
	assert.ok(Math.abs(run.usage.cost - 0.03) < 1e-9);
	assert.ok(run.attemptHistory![0].diagnostics.some((message) => /injected evidence observer failure/.test(message)));
	assert.ok(Math.abs((await live.scheduler.snapshot()).cost - 0.03) < 1e-9);

	const session = telemetryRunner("accounting-session-crash");
	const add = session.scheduler.addUsage.bind(session.scheduler);
	let rejected = false;
	const rejectOnce = mock.method(session.scheduler, "addUsage", async (...args: Parameters<Scheduler["addUsage"]>) => {
		if (!rejected) { rejected = true; throw new Error("injected recover ledger rejection"); }
		return add(...args);
	});
	try { run = await session.run(defaults, agent, "recovery retry"); } finally { rejectOnce.mock.restore(); }
	assert.equal(rejected, true);
	assert.equal(run.status, "error");
	assert.equal(run.messages.length, 3);
	assert.ok(Math.abs(run.usage.cost - 0.03) < 1e-9, `recovery remained poisoned: ${run.usage.cost}`);
	assert.ok(Math.abs((await session.scheduler.snapshot()).cost - 0.03) < 1e-9);
});

test("optional telemetry is ordered on RPC arrival and finishes only after cleanup and final persistence", async () => {
	const events: RunnerEvent[] = [];
	let savedAtFinish = false;
	const runner = telemetryRunner("telemetry-stream", { onEvent: (event) => {
		events.push(event);
		if (event.type === "finished") {
			const saved = loadRunById(event.runId)!;
			savedAtFinish = saved.status === "ok" && !!saved.endedAt && fs.existsSync(saved.artifacts!.manifest!) &&
				fs.existsSync(saved.artifacts!.output!);
		}
	} });
	const run = await runner.run(defaults, agent, "timings");
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(savedAtFinish, true);
	assert.deepEqual(events.map((event) => event.type), ["queued", "admitted", "spawned", "prompt_sent", "prompt_accepted",
		"first_token", "settled", "finished"]);
	assert.ok(events.every((event, i) => event.runId === run.id && Number.isFinite(event.at) &&
		(i === 0 || event.at >= events[i - 1].at)));
	assert.ok(events.slice(2).every((event) => event.attempt === 1 && event.pid === run.childPid));
	assert.ok(events.at(-1)!.at - events.at(-2)!.at >= 30, "settled must precede the delayed statistics await");
	assert.deepEqual((await runner.scheduler.snapshot()).leases, []);
});

test("telemetry does not fabricate first-token timing for message-end-only peers, and isolates observer failures", async () => {
	for (const asyncFailure of [false, true]) {
		const events: RunnerEvent[] = [];
		const runner = telemetryRunner("telemetry-message-only", { onEvent: (event) => {
			events.push(event);
			if (asyncFailure) return Promise.reject(new Error("async observer failed"));
			throw new Error("observer failed");
		} });
		const run = await runner.run(defaults, agent, "no stream");
		assert.equal(run.status, "ok", run.errorMessage);
		assert.equal(events.filter((event) => event.type === "first_token").length, 0);
		assert.equal(events.filter((event) => event.type === "finished").length, 1);
		assert.equal(events.at(-1)!.type, "finished");
		assert.deepEqual((await runner.scheduler.snapshot()).leases, []);
		assert.equal(loadRunById(run.id)?.status, "ok");
	}
});

test("telemetry first-token identity resets per attempt, while queued/admitted/finished occur once", async () => {
	const events: RunnerEvent[] = [];
	const run = await telemetryRunner("telemetry-retry", { onEvent: (event) => events.push(event) }).run(defaults, agent,
		"retry timings", { retries: 1, outputFormat: "json" });
	assert.equal(run.status, "ok", run.errorMessage);
	assert.equal(run.attempts, 2);
	assert.deepEqual(events.filter((event) => event.type === "first_token").map((event) => event.attempt), [1, 2]);
	assert.deepEqual(events.filter((event) => event.type === "settled").map((event) => event.attempt), [1, 2]);
	for (const type of ["queued", "admitted", "finished"])
		assert.equal(events.filter((event) => event.type === type).length, 1);
	assert.equal(events.at(-1)!.attempt, 2);
});

test("queued/admitted telemetry exposes admission waiting without starting process or prompt timings", { timeout: 5000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1 });
	const release = await scheduler.acquire("telemetry-blocker");
	const events: RunnerEvent[] = [];
	let queued!: () => void;
	const arrived = new Promise<void>((resolve) => { queued = resolve; });
	const runner = telemetryRunner("telemetry-message-only", { scheduler, onEvent: (event) => {
		events.push(event);
		if (event.type === "queued") queued();
	} });
	const pending = runner.run(defaults, agent, "wait for admission");
	try {
		await arrived;
		await delay(120);
		assert.deepEqual(events.map((event) => event.type), ["queued"]);
	} finally { await release(); }
	const run = await pending;
	assert.equal(run.status, "ok", run.errorMessage);
	assert.ok(events[1].at - events[0].at >= 100);
	assert.equal(events[1].type, "admitted");
	assert.equal(events.at(-1)!.type, "finished");
});

test("early validation, pre-abort, admission cancellation, and spawn/guard failures still finish telemetry exactly once", async () => {
	for (const scenario of ["invalid", "aborted", "spawn", "guard", "queue-cancel"]) {
		const events: RunnerEvent[] = [];
		const scheduler = new Scheduler(undefined, { concurrency: 1 });
		const release = scenario === "queue-cancel" ? await scheduler.acquire("early-error-blocker") : undefined;
		const controller = new AbortController();
		const runner = scenario === "guard" ? runnerFor("no-guard", { scheduler, onEvent: (event) => events.push(event) }) :
			telemetryRunner("telemetry-message-only", { scheduler, onEvent: (event) => {
				events.push(event);
				if (scenario === "queue-cancel" && event.type === "queued") controller.abort();
			}, ...(scenario === "spawn" ? { invocation: { command: "/nonexistent/pi-subagents-telemetry" } } : {}) });
		if (scenario === "aborted") controller.abort();
		let run;
		try {
			run = await runner.run(defaults, agent, "early error", scenario === "invalid" ? { retries: -1 } : {}, undefined, controller.signal);
		} finally { await release?.(); }
		assert.notEqual(run.status, "ok", scenario);
		assert.equal(events.filter((event) => event.type === "finished").length, 1, scenario);
		assert.equal(events.at(-1)!.type, "finished");
		assert.equal(events.filter((event) => event.type === "first_token" || event.type === "prompt_sent").length, 0);
		assert.equal(loadRunById(run.id)?.status, run.status);
		assert.deepEqual((await scheduler.snapshot()).leases, []);
	}
});
