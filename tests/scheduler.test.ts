import { temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Scheduler, BudgetError } from "../src/scheduler.ts";
import { setTimeout as delay } from "node:timers/promises";
import { writeJson } from "../src/files.ts";

test("default tree admits twenty workers and queues additional work", { timeout: 5000 }, async () => {
	const scheduler = new Scheduler();
	const releases: Array<() => Promise<void>> = [];
	try {
		for (let i = 0; i < 20; i++) releases.push(await scheduler.acquire(`worker-${i}`, AbortSignal.timeout(2000)));
		assert.equal((await scheduler.snapshot()).leases.filter((l) => l.active).length, 20);
		await assert.rejects(() => scheduler.acquire("queued", AbortSignal.timeout(100)), /abort|timeout/i);
	} finally {
		for (const release of releases) await release();
	}
});

test("unlimited run and turn budgets persist and permit work beyond the old defaults", async () => {
	const scheduler = new Scheduler();
	const state = await scheduler.snapshot();
	state.runs = 128;
	state.turns = 1000;
	writeJson(scheduler.file, state);
	const saved = JSON.parse(fs.readFileSync(scheduler.file, "utf8"));
	assert.deepEqual(saved.limits, { concurrency: 20 });
	const resumed = new Scheduler(scheduler.id, { maxRuns: 1, maxTurns: 1 });
	const release = await resumed.acquire("beyond-old-defaults");
	await resumed.beginTurn();
	await resumed.addUsage("beyond-old-defaults", {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.25,
		contextTokens: 15,
		turns: 0,
	});
	await release();
	const totals = await resumed.snapshot();
	assert.equal(totals.runs, 129);
	assert.equal(totals.turns, 1001);
	assert.equal(totals.cost, 0.25);
});

test("existing ledgers retain saved limits and consumption after a defaults change", async () => {
	const limits = { concurrency: 4, maxRuns: 128, maxTurns: 1000, maxCost: 1 };
	const scheduler = new Scheduler(undefined, limits);
	const state = await scheduler.snapshot();
	state.runs = 128;
	state.turns = 1000;
	state.cost = 0.5;
	writeJson(scheduler.file, state);
	const resumed = new Scheduler(scheduler.id);
	const restored = await resumed.snapshot();
	assert.deepEqual(restored.limits, limits);
	assert.equal(restored.cost, 0.5);
	await assert.rejects(() => resumed.acquire("new-run"), /run budget/);
	await assert.rejects(() => resumed.beginTurn(), /turn budget/);
});

test("environment limits remain opt-in and enforced", async (t) => {
	const env = {
		PI_SUBAGENTS_EX_CONCURRENCY: "2",
		PI_SUBAGENTS_EX_MAX_RUNS: "1",
		PI_SUBAGENTS_EX_MAX_TOTAL_TURNS: "1",
		PI_SUBAGENTS_EX_MAX_COST: "0.5",
	};
	Object.assign(process.env, env);
	t.after(() => {
		for (const key of Object.keys(env)) delete process.env[key];
	});
	const scheduler = new Scheduler();
	assert.deepEqual((await scheduler.snapshot()).limits, { concurrency: 2, maxRuns: 1, maxTurns: 1, maxCost: 0.5 });
	const release = await scheduler.acquire("one");
	await scheduler.beginTurn();
	await assert.rejects(() => scheduler.acquire("two"), /run budget/);
	await assert.rejects(() => scheduler.beginTurn(), /turn budget/);
	await scheduler.addCost(0.5);
	assert.match((await scheduler.budgetReason())!, /cost budget/);
	await release();
});

test("separate processes share one admission limit without losing updates", { timeout: 15000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 2 });
	await scheduler.snapshot();
	const log = path.join(temp, "scheduling.jsonl");
	const fixture = fileURLToPath(new URL("./fixtures/scheduler-worker.ts", import.meta.url));
	await Promise.all(
		Array.from({ length: 6 }, (_, i) =>
			promisify(execFile)(process.execPath, [fixture, scheduler.id, `worker-${i}`, log]),
		),
	);
	let active = 0;
	for (const row of fs
		.readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((s) => JSON.parse(s))) {
		active += row.event === "start" ? 1 : -1;
		assert.ok(active >= 0 && active <= 2, `active=${active}`);
	}
	assert.equal(active, 0);
	const state = await scheduler.snapshot();
	assert.equal(state.runs, 6);
	assert.equal(state.leases.length, 0);
});

test(
	"a waiting parent yields the only slot to its descendant and returns completed results at the cost ceiling",
	{ timeout: 5000 },
	async () => {
		const scheduler = new Scheduler(undefined, { concurrency: 1, maxCost: 1 });
		const release = await scheduler.acquire("parent");
		process.env.PI_SUBAGENTS_EX_LEASE_ID = "parent";
		try {
			const result = await scheduler.whileWaiting(async () => {
				const childRelease = await scheduler.acquire("child");
				assert.equal((await scheduler.snapshot()).leases.filter((l) => l.active).length, 1);
				await scheduler.addCost(1);
				await childRelease();
				return "completed result";
			});
			assert.equal(result, "completed result");
			await assert.rejects(() => scheduler.beginTurn(), BudgetError);
		} finally {
			delete process.env.PI_SUBAGENTS_EX_LEASE_ID;
			await release();
		}
	},
);

test("aborting a queued request removes its lease without disturbing active work", async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1 });
	const release = await scheduler.acquire("first");
	const controller = new AbortController();
	const pending = scheduler.acquire("second", controller.signal);
	const rejected = assert.rejects(pending, /abort/i);
	await delay(30);
	controller.abort();
	await rejected;
	assert.deepEqual(
		(await scheduler.snapshot()).leases.map((l) => l.id),
		["first"],
	);
	await release();
});

test("shared run and turn ceilings are atomic under contention", async () => {
	const scheduler = new Scheduler(undefined, { maxTurns: 2, maxRuns: 1 });
	const release = await scheduler.acquire("one");
	await assert.rejects(() => scheduler.acquire("two"), /run budget/);
	await release();
	const turns = await Promise.allSettled(Array.from({ length: 6 }, () => scheduler.beginTurn()));
	assert.equal(turns.filter((r) => r.status === "fulfilled").length, 2);
	assert.equal((await scheduler.snapshot()).turns, 2);
	assert.throws(() => new Scheduler(undefined, { concurrency: 0.5 }));
});
