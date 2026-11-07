import { agent, defaults } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Runner } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";

const peer = fileURLToPath(new URL("./fixtures/accounting-pi.mjs", import.meta.url));
function runnerFor(scenario: string, scheduler = new Scheduler()) {
	return new Runner({ scheduler, invocation: { command: process.execPath, prefix: [peer, scenario] },
		killGraceMs: 100, stallTimeoutMs: 500 });
}
function close(actual: number, expected: number) {
	assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, received ${actual}`);
}

test("every exit recovers native usage and lost message frames without re-debiting guard receipts", { timeout: 10000 }, async (t) => {
	for (const [scenario, status] of [["complete", "ok"], ["cancel", "timeout"], ["crash", "error"]]) {
		await t.test(scenario, async () => {
			const runner = runnerFor(scenario);
			const run = await runner.run(defaults, agent, "durable work");
			assert.equal(run.status, status, `${run.errorMessage}\n${run.stderr}`);
			close(run.usage.cost, 1);
			assert.equal(run.usage.input, 100);
			assert.equal(run.usage.output, 50);
			assert.equal(run.usage.turns, 1);
			assert.equal(run.messages.filter((message) => message.role === "assistant").length, 1);
			close(run.attemptHistory![0].usage.cost, 1);
			const tree = await runner.scheduler.snapshot();
			close(tree.cost, 1);
			assert.equal(tree.leases.length, 0);
		});
	}
});

test("startup and late native writes are recovered before statistics reconciliation", { timeout: 10000 }, async (t) => {
	for (const scenario of ["startup", "late-stats", "shutdown-late"]) {
		await t.test(scenario, async () => {
			const runner = runnerFor(scenario);
			const run = await runner.run(defaults, agent, "durable work");
			assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
			close(run.usage.cost, 0.5);
			assert.equal(run.usage.input, 50);
			assert.equal(run.usage.output, 25);
			close((await runner.scheduler.snapshot()).cost, 0.5);
		});
	}
});

test("startup, receipts, request-time and post-snapshot writes do not mask statistics-only charges", { timeout: 15000 }, async (t) => {
	for (const [scenario, expected] of [["startup-stats-only", 0.8], ["receipt-stats-only", 0.6],
		["late-stats-only", 0.8], ["shutdown-stats-only", 0.8]] as const) {
		await t.test(scenario, async () => {
			const runner = runnerFor(scenario);
			const original = await runner.run(defaults, agent, "original");
			for (const run of [original, await runner.run(defaults, agent, "continuation", { resumeFrom: original })]) {
				assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
				close(run.usage.cost, expected);
				close(run.usage.input, expected * 100);
				close(run.usage.output, expected * 50);
			}
			close((await runner.scheduler.snapshot()).cost, 2 * expected);
		});
	}
});

test("copied native entries are historical, not new usage in independent continuations", { timeout: 10000 }, async () => {
	const runner = runnerFor("complete");
	const original = await runner.run(defaults, agent, "original");
	assert.equal(original.status, "ok", original.errorMessage);
	for (const task of ["first branch", "second branch"]) {
		const run = await runner.run(defaults, agent, task, { resumeFrom: original });
		assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
		close(run.usage.cost, 1);
		assert.equal(run.usage.input, 100);
	}
	close((await runner.scheduler.snapshot()).cost, 3);
});
