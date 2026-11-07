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
import { emptyUsage } from "../src/types.ts";

const defaultCaps = { maxProcesses: 64, maxQueued: 256, maxRequests: 20 };

async function until(fn: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!(await fn())) {
		assert.ok(Date.now() < deadline, "scheduler condition timed out");
		await delay(5);
	}
}

function fingerprint(file: string) {
	const stat = fs.statSync(file, { bigint: true });
	return { ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs, size: stat.size, contents: fs.readFileSync(file, "utf8") };
}

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
	assert.deepEqual(saved.limits, { concurrency: 20, ...defaultCaps });
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
	assert.deepEqual(restored.limits, { ...limits, ...defaultCaps });
	assert.equal(restored.cost, 0.5);
	await assert.rejects(() => resumed.acquire("new-run"), /run budget/);
	await assert.rejects(() => resumed.beginTurn(), /turn budget/);
});

test("environment limits are parsed and enforced", async (t) => {
	const env = {
		PI_SUBAGENTS_EX_CONCURRENCY: "2",
		PI_SUBAGENTS_EX_MAX_PROCESSES: "3",
		PI_SUBAGENTS_EX_MAX_QUEUED: "4",
		PI_SUBAGENTS_EX_MAX_REQUESTS: "1",
		PI_SUBAGENTS_EX_MAX_RUNS: "1",
		PI_SUBAGENTS_EX_MAX_TOTAL_TURNS: "1",
		PI_SUBAGENTS_EX_MAX_COST: "0.5",
	};
	Object.assign(process.env, env);
	t.after(() => {
		for (const key of Object.keys(env)) delete process.env[key];
	});
	const scheduler = new Scheduler();
	assert.deepEqual((await scheduler.snapshot()).limits, {
		concurrency: 2, maxProcesses: 3, maxQueued: 4, maxRequests: 1, maxRuns: 1, maxTurns: 1, maxCost: 0.5,
	});
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
	await scheduler.addCost(0); // A mutation, not snapshot(), establishes this tree's configured limits.
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
		const scheduler = new Scheduler(undefined, { concurrency: 1, maxProcesses: 2, maxRequests: 1, maxCost: 1 });
		const release = await scheduler.acquire("parent");
		process.env.PI_SUBAGENTS_EX_LEASE_ID = "parent";
		try {
			const result = await scheduler.whileWaiting(async () => {
				const childRelease = await scheduler.acquire("child");
				const state = await scheduler.snapshot();
				assert.equal(state.leases.filter((l) => l.active).length, 1);
				assert.equal(state.leases.filter((l) => l.processReserved).length, 2);
				assert.equal(state.leases.find((l) => l.id === "parent")?.parked, 1);
				await assert.rejects(() => scheduler.acquire("overflow-child"), /live process limit.*nested admission/i);
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

for (const limits of [{ concurrency: 1, maxProcesses: 2 }, { concurrency: 3, maxProcesses: 1 }]) {
	test(`execution/process caps are independent and queued work reserves no process: ${JSON.stringify(limits)}`, async () => {
		const scheduler = new Scheduler(undefined, { ...limits, maxQueued: 1 });
		const first = await scheduler.acquire("first");
		const controller = new AbortController();
		const pending = scheduler.acquire("second", controller.signal);
		void pending.catch(() => {});
		try {
			await until(async () => (await scheduler.snapshot()).leases.length === 2);
			const state = await scheduler.snapshot();
			assert.equal(state.leases.filter((l) => l.active).length, 1);
			assert.equal(state.leases.filter((l) => l.processReserved).length, 1);
			assert.equal(state.leases.find((l) => l.id === "second")?.processReserved, false);
			const before = fingerprint(scheduler.file);
			await assert.rejects(() => scheduler.acquire("overflow"), (err: unknown) => {
				assert.ok(err instanceof BudgetError);
				assert.match(err.message, /waiting queue limit.*1/);
				return true;
			});
			assert.deepEqual(fingerprint(scheduler.file), before);
			assert.equal((await scheduler.snapshot()).runs, 2);
			assert.equal((await scheduler.snapshot()).usageByRun.overflow, undefined);
			await first();
			const second = await pending;
			assert.equal((await scheduler.snapshot()).leases[0].processReserved, true);
			await second();
		} finally {
			controller.abort();
			await pending.then((release) => release(), () => {});
			await first();
		}
	});
}

test("a saturated parked parent fails nested admission closed and recovers its execution slot", { timeout: 3000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxProcesses: 1 });
	const release = await scheduler.acquire("parent");
	process.env.PI_SUBAGENTS_EX_LEASE_ID = "parent";
	try {
		await assert.rejects(
			() => scheduler.whileWaiting(() => scheduler.acquire("child")),
			(err: unknown) => {
				assert.ok(err instanceof BudgetError);
				assert.match(err.message, /live process limit.*nested admission.*deadlock/);
				return true;
			},
		);
		const state = await scheduler.snapshot();
		assert.equal(state.runs, 1);
		assert.equal(state.leases.length, 1);
		assert.equal(state.leases[0].active, true);
		assert.equal(state.leases[0].parked, 0);
		assert.equal(state.leases[0].processReserved, true);
	} finally {
		delete process.env.PI_SUBAGENTS_EX_LEASE_ID;
		await release();
	}
});

test("a resuming parent bypasses a full new-admission queue blocked on its process reservation", { timeout: 3000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxProcesses: 1, maxQueued: 1 });
	const release = await scheduler.acquire("parent");
	const controller = new AbortController();
	const pending = scheduler.acquire("queued-root", controller.signal);
	void pending.catch(() => {});
	try {
		await until(async () => (await scheduler.snapshot()).leases.length === 2);
		process.env.PI_SUBAGENTS_EX_LEASE_ID = "parent";
		assert.equal(await scheduler.whileWaiting(async () => "completed"), "completed");
		assert.equal((await scheduler.snapshot()).leases.find((l) => l.id === "parent")?.active, true);
		delete process.env.PI_SUBAGENTS_EX_LEASE_ID;
		await release();
		await (await pending)();
	} finally {
		delete process.env.PI_SUBAGENTS_EX_LEASE_ID;
		controller.abort();
		await pending.then((done) => done(), () => {});
		await release();
	}
});

test("request reservation holds through a simulated stream, retries once, and releases before tools", { timeout: 3000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxProcesses: 1, maxRequests: 1 });
	const workerRelease = await scheduler.acquire("worker");
	const release = await scheduler.acquireRequest("worker");
	const beforeRetry = fingerprint(scheduler.file);
	const retryRelease = await new Scheduler(scheduler.id).acquireRequest("worker");
	assert.deepEqual(fingerprint(scheduler.file), beforeRetry);
	let secondStarted = false;
	const controller = new AbortController();
	const pending = scheduler.acquireRequest("next-stream", controller.signal).then((done) => {
		secondStarted = true;
		return done;
	});
	void pending.catch(() => {});
	try {
		await until(async () => (await scheduler.snapshot()).requests.length === 2);
		await delay(100); // A provider returning a stream handle is not the end of the request.
		assert.equal(secondStarted, false);
		assert.equal((await scheduler.snapshot()).requests.filter((r) => r.active).length, 1);
		await retryRelease(); // assistant message_end, before executing the tool call.
		const secondRelease = await pending;
		assert.equal(secondStarted, true);
		assert.equal((await scheduler.snapshot()).leases.filter((l) => l.active).length, 1);
		await secondRelease();
		const toolTimeRequest = await scheduler.acquireRequest("tool-time-stream");
		await toolTimeRequest();
		await release(); // Retry callbacks are idempotent, not reference-counted.
	} finally {
		controller.abort();
		await pending.then((done) => done(), () => {});
		await workerRelease();
	}
	assert.equal((await scheduler.snapshot()).requests.length, 0);
});

test("request wait notifications cover actual waits and cancellation outside the ledger lock", async () => {
	const scheduler = new Scheduler(undefined, { maxRequests: 1 });
	const notifications: Array<{ waiting: boolean; locked: boolean }> = [];
	const onWait = (waiting: boolean) => {
		notifications.push({ waiting, locked: fs.existsSync(`${scheduler.file}.lock`) });
		throw new Error("An observer failure must not own a permit");
	};
	const first = await scheduler.acquireRequest("first", undefined, onWait);
	assert.equal(notifications.length, 0);
	const pending = scheduler.acquireRequest("second", undefined, onWait);
	await until(() => notifications.length === 1);
	await first();
	const second = await pending;
	const retry = await scheduler.acquireRequest("second", undefined, onWait);
	assert.deepEqual(notifications, [{ waiting: true, locked: false }, { waiting: false, locked: false }]);
	const controller = new AbortController();
	const rejected = assert.rejects(scheduler.acquireRequest("cancelled", controller.signal, onWait), /abort/i);
	await until(() => notifications.length === 3);
	controller.abort();
	await rejected;
	assert.deepEqual(notifications.map((n) => n.waiting), [true, false, true, false]);
	assert.ok(notifications.every((n) => !n.locked));
	await second();
	await retry();
	assert.equal((await scheduler.snapshot()).requests.length, 0);
});

test("request cap is independent of execution concurrency and process capacity", async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxProcesses: 1, maxRequests: 3 });
	const release = await scheduler.acquire("worker");
	const requests: Array<() => Promise<void>> = [];
	try {
		for (let i = 0; i < 3; i++) requests.push(await scheduler.acquireRequest(`request-${i}`));
		const state = await scheduler.snapshot();
		assert.equal(state.leases.filter((l) => l.active).length, 1);
		assert.equal(state.leases.filter((l) => l.processReserved).length, 1);
		assert.equal(state.requests.filter((r) => r.active).length, 3);
	} finally {
		for (const done of requests) await done();
		await release();
	}
});

test("worker and request waiters share a bounded queue and request overflow leaves no receipt", async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxRequests: 1, maxQueued: 1 });
	const release = await scheduler.acquire("worker");
	const requestRelease = await scheduler.acquireRequest("worker");
	const controller = new AbortController();
	const pending = scheduler.acquire("queued-worker", controller.signal);
	const rejected = assert.rejects(pending, /abort/i);
	try {
		await until(async () => (await scheduler.snapshot()).leases.length === 2);
		const before = fingerprint(scheduler.file);
		await assert.rejects(() => scheduler.acquireRequest("overflow-request"), /waiting queue limit/);
		assert.deepEqual(fingerprint(scheduler.file), before);
		assert.equal((await scheduler.snapshot()).requests.length, 1);
	} finally {
		controller.abort();
		await rejected;
		await requestRelease();
		await release();
	}
});

test("releasing a run cleans active and waiting attempt IDs owned by that run", async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 2, maxRequests: 1 });
	const first = await scheduler.acquire("one");
	const second = await scheduler.acquire("two");
	try {
		process.env.PI_SUBAGENTS_EX_LEASE_ID = "one";
		const active = await scheduler.acquireRequest("one-attempt");
		process.env.PI_SUBAGENTS_EX_LEASE_ID = "two";
		const pending = scheduler.acquireRequest("two-attempt");
		const lost = assert.rejects(pending, /reservation was lost/);
		await until(async () => (await scheduler.snapshot()).requests.length === 2);
		delete process.env.PI_SUBAGENTS_EX_LEASE_ID;
		await new Scheduler(scheduler.id).release("two");
		await lost;
		await first();
		assert.equal((await scheduler.snapshot()).requests.length, 0);
		await active();
		process.env.PI_SUBAGENTS_EX_LEASE_ID = "one";
		await assert.rejects(() => scheduler.acquireRequest("after-release"), /lease was lost/);
	} finally {
		delete process.env.PI_SUBAGENTS_EX_LEASE_ID;
		await first();
		await second();
	}
});

test("old request release callbacks cannot revoke a newer reservation of the same attempt ID", async () => {
	const scheduler = new Scheduler();
	const first = await scheduler.acquireRequest("attempt");
	await first();
	const second = await scheduler.acquireRequest("attempt");
	await first();
	assert.equal((await scheduler.snapshot()).requests.length, 1);
	await new Scheduler(scheduler.id).releaseRequest("attempt");
	await second();
	const before = fingerprint(scheduler.file);
	await scheduler.releaseRequest("attempt");
	assert.deepEqual(fingerprint(scheduler.file), before);
});

test("read APIs neither initialize nor rewrite a ledger; duplicate usage debit is also a no-op", async () => {
	const scheduler = new Scheduler();
	assert.equal(await scheduler.budgetReason(), undefined);
	assert.deepEqual(await scheduler.subtreeUsage("owner"), emptyUsage());
	await scheduler.snapshot();
	assert.equal(fs.existsSync(scheduler.file), false);
	assert.equal(fs.existsSync(`${scheduler.file}.lock`), false);
	const release = await scheduler.acquire("owner");
	try {
		const usage = { ...emptyUsage(), input: 10, cost: 0.25 };
		await scheduler.addUsage("owner", usage, "receipt");
		const before = fingerprint(scheduler.file);
		for (let i = 0; i < 3; i++) {
			assert.equal(await scheduler.budgetReason(), undefined);
			assert.equal((await scheduler.subtreeUsage("owner")).cost, 0.25);
			assert.equal((await scheduler.snapshot()).cost, 0.25);
		}
		await scheduler.addUsage("owner", usage, "receipt");
		await scheduler.addCost(0);
		await scheduler.release("absent");
		await scheduler.releaseRequest("absent");
		assert.deepEqual(fingerprint(scheduler.file), before);
	} finally {
		await release();
	}
});

test("blocked admission and request polls do not rewrite the ledger", { timeout: 5000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxProcesses: 1, maxRequests: 1 });
	const release = await scheduler.acquire("owner");
	const requestRelease = await scheduler.acquireRequest("owner");
	const controller = new AbortController();
	const workerRejected = assert.rejects(scheduler.acquire("queued", controller.signal), /abort/i);
	const requestRejected = assert.rejects(scheduler.acquireRequest("queued-request", controller.signal), /abort/i);
	try {
		await until(async () => {
			const state = await scheduler.snapshot();
			return state.leases.length === 2 && state.requests.length === 2;
		});
		const before = fingerprint(scheduler.file);
		await delay(1100); // Includes several backoff polls as well as watcher wakeups.
		assert.deepEqual(fingerprint(scheduler.file), before);
	} finally {
		controller.abort();
		await Promise.all([workerRejected, requestRejected]);
		await requestRelease();
		await release();
	}
});

test("cancelling waiters removes their entries, timers, and shared watcher", { timeout: 5000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxRequests: 1 });
	const release = await scheduler.acquire("owner");
	const requestRelease = await scheduler.acquireRequest("owner");
	const resources = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout" || name === "FSEventWrap").sort();
	const baseline = resources();
	const controller = new AbortController();
	const waits = Array.from({ length: 4 }, (_, i) => [
		assert.rejects(scheduler.acquire(`worker-${i}`, controller.signal), /abort/i),
		assert.rejects(scheduler.acquireRequest(`request-${i}`, controller.signal), /abort/i),
	]).flat();
	try {
		await until(async () => {
			const s = await scheduler.snapshot();
			return s.leases.length === 5 && s.requests.length === 5;
		});
		controller.abort();
		await Promise.all(waits);
		await delay(20); // fs.watch close completion is asynchronous.
		assert.deepEqual(resources(), baseline);
		assert.equal((await scheduler.snapshot()).leases.length, 1);
		assert.equal((await scheduler.snapshot()).requests.length, 1);
	} finally {
		controller.abort();
		await Promise.all(waits);
		await requestRelease();
		await release();
	}
	const aborted = new AbortController();
	aborted.abort();
	const untouched = new Scheduler();
	await assert.rejects(() => untouched.acquire("worker", aborted.signal), /abort/i);
	await assert.rejects(() => untouched.acquireRequest("request", aborted.signal), /abort/i);
	assert.equal(fs.existsSync(untouched.file), false);
});

test("legacy migration preserves saved limits, consumption, usage, and dedup receipts without read writes", async () => {
	const scheduler = new Scheduler();
	const legacy = JSON.parse(fs.readFileSync(new URL("./fixtures/scheduler-legacy.json", import.meta.url), "utf8"));
	legacy.id = scheduler.id;
	legacy.leases = [{ id: "legacy-run", pid: process.pid, active: false, parked: 1, order: 0 }];
	writeJson(scheduler.file, legacy);
	const before = fingerprint(scheduler.file);
	const other = new Scheduler(scheduler.id, {
		concurrency: 32, maxProcesses: 1, maxQueued: 1, maxRequests: 1, maxRuns: 1, maxTurns: 1, maxCost: 0.01,
	});
	const restored = await other.snapshot();
	assert.deepEqual(restored.limits, { ...legacy.limits, ...defaultCaps });
	assert.equal(restored.leases[0].processReserved, true);
	assert.deepEqual(restored.requests, []);
	assert.equal((await other.subtreeUsage("legacy-run")).cost, 0.75);
	assert.equal(await other.budgetReason(), undefined);
	assert.deepEqual(fingerprint(scheduler.file), before);
	const originalUsage = legacy.usageByRun["legacy-run"].usage;
	await other.addUsage("legacy-run", originalUsage, "legacy-event"); // Migration may persist; the debit must not repeat.
	assert.equal((await scheduler.snapshot()).cost, 0.75);
	assert.deepEqual(JSON.parse(fs.readFileSync(scheduler.file, "utf8")).limits, restored.limits);
	await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? scheduler : other).addUsage(
		"legacy-run", { ...emptyUsage(), input: 10, cost: 0.25 }, "new-event",
	)));
	await other.beginTurn();
	await other.release("legacy-run");
	const release = await other.acquire("new-run");
	await release();
	const state = await scheduler.snapshot();
	assert.equal(state.runs, 13);
	assert.equal(state.turns, 31);
	assert.equal(state.cost, 1);
	assert.equal((await scheduler.subtreeUsage("legacy-run")).input, 40);
	assert.deepEqual(state.usageByRun["legacy-run"].usageEvents, { "legacy-event": true, "new-event": true });
});

test("new cap values enforce integer ranges for options and environment", () => {
	for (const [key, env, max] of [
		["maxProcesses", "PI_SUBAGENTS_EX_MAX_PROCESSES", 256],
		["maxQueued", "PI_SUBAGENTS_EX_MAX_QUEUED", 10_000],
		["maxRequests", "PI_SUBAGENTS_EX_MAX_REQUESTS", 128],
	] as const) {
		for (const value of [0, max + 1, 1.5, NaN, Infinity]) {
			assert.throws(() => new Scheduler(undefined, { [key]: value }), /integer/);
			process.env[env] = String(value);
			try {
				assert.throws(() => new Scheduler(), new RegExp(env));
			} finally {
				delete process.env[env];
			}
		}
		assert.doesNotThrow(() => new Scheduler(undefined, { [key]: 1 }));
		assert.doesNotThrow(() => new Scheduler(undefined, { [key]: max }));
	}
});

test("separate processes share independent live-process and streamed-request caps", { timeout: 15000 }, async () => {
	const scheduler = new Scheduler(undefined, { concurrency: 4, maxProcesses: 2, maxRequests: 1, maxQueued: 16 });
	await scheduler.addCost(0);
	const log = path.join(temp, "request-scheduling.jsonl");
	const fixture = fileURLToPath(new URL("./fixtures/scheduler-reservations.ts", import.meta.url));
	await Promise.all(Array.from({ length: 6 }, (_, i) => promisify(execFile)(process.execPath, [fixture, scheduler.id, `worker-${i}`, log])));
	let workers = 0, requests = 0, maxWorkers = 0, maxRequests = 0;
	for (const row of fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))) {
		if (row.event === "worker-start") workers++;
		if (row.event === "worker-end") workers--;
		if (row.event === "request-start") requests++;
		if (row.event === "request-end") requests--;
		assert.ok(workers >= 0 && workers <= 2, `live workers=${workers}`);
		assert.ok(requests >= 0 && requests <= 1, `streamed requests=${requests}`);
		maxWorkers = Math.max(maxWorkers, workers);
		maxRequests = Math.max(maxRequests, requests);
	}
	assert.equal(maxWorkers, 2);
	assert.equal(maxRequests, 1);
	assert.equal(workers, 0);
	assert.equal(requests, 0);
	const state = await scheduler.snapshot();
	assert.equal(state.runs, 6);
	assert.equal(state.leases.length, 0);
	assert.equal(state.requests.length, 0);
});

for (const mode of ["all", "request-only"]) {
	test(`dead holders are pruned without read writes, even if the dispatching lease stays alive: ${mode}`, { timeout: 5000 }, async () => {
		const scheduler = new Scheduler(undefined, { concurrency: 1, maxProcesses: 1, maxRequests: 1 });
		await scheduler.addCost(0);
		const release = mode === "request-only" ? await scheduler.acquire("holder") : undefined;
		const fixture = fileURLToPath(new URL("./fixtures/scheduler-dead-holder.ts", import.meta.url));
		await promisify(execFile)(process.execPath, [fixture, scheduler.id, "holder", mode]);
		const before = fingerprint(scheduler.file);
		const observed = await scheduler.snapshot();
		assert.equal(observed.requests.length, 0);
		assert.equal(observed.leases.length, mode === "request-only" ? 1 : 0);
		assert.deepEqual(fingerprint(scheduler.file), before);
		const permit = await scheduler.acquireRequest("replacement-request");
		await permit();
		await release?.();
		const replacement = await scheduler.acquire("replacement-worker");
		await replacement();
		assert.equal(JSON.parse(fs.readFileSync(scheduler.file, "utf8")).requests.length, 0);
		assert.equal((await scheduler.snapshot()).leases.length, 0);
	});
}
