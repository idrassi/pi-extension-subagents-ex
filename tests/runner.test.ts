import { agent, defaults } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Runner, type RunnerOptions } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";
import { getFinalOutput } from "../src/format.ts";
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
