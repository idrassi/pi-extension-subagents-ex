import { defaults } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TaskManager, waitForTask } from "../src/tasks.ts";
import { UsageLedger } from "../src/accounting.ts";
import { newRunRecord } from "../src/types.ts";
import { resultFor } from "../src/orchestrator.ts";
import { toModelUsage } from "../src/format.ts";

function result(status: "ok" | "error" | "running" = "ok", cost = 0.5) {
	const record = newRunRecord(`run-${randomUUID()}`, "test", "user", "task", defaults.cwd);
	record.usage.cost = cost;
	record.usage.input = 10;
	record.status = status;
	return resultFor({ mode: "single", results: [record], status, agentScope: "user", projectAgentsDir: null });
}

test("background progress carries usage before completion and settled snapshots recover", async () => {
	const session = randomUUID();
	const manager = new TaskManager(session);
	let finish!: () => void;
	const waiting = new Promise<void>((r) => {
		finish = r;
	});
	const task = manager.start("single", "worker", false, async (_signal, update) => {
		update(result("running", 0.2));
		await waiting;
		return result("ok", 0.5);
	});
	await Promise.resolve();
	assert.equal(task.status, "running");
	assert.equal(task.usage.cost, 0.2);
	finish();
	await task.done;
	assert.equal(task.status, "done");
	assert.equal(task.usage.cost, 0.5);
	const recovered = new TaskManager(session).get(task.id)!;
	assert.equal(recovered.status, "done");
	assert.equal(recovered.usage.cost, 0.5);
	assert.equal(recovered.result?.details.results[0].id, task.result?.details.results[0].id);
});

test("empty setup failures remain errors; shutdown cancels outstanding tasks", async () => {
	const manager = new TaskManager();
	const failure = manager.start("chain", "setup failure", false, async () =>
		resultFor({
			mode: "chain",
			status: "error",
			errorMessage: "No repository",
			results: [],
			projectAgentsDir: null,
			agentScope: "user",
		}),
	);
	await failure.done;
	assert.equal(failure.status, "error");
	const running = manager.start("single", "active", false, async (signal) => {
		if (!signal.aborted)
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return result("error");
	});
	await manager.shutdown();
	assert.equal(running.status, "killed");
});

test("background usage is attributed without collection and deduplicated across reads and reloads", async () => {
	const manager = new TaskManager();
	const task = manager.start("single", "worker", false, async () => result());
	await task.done;
	const message = {
		role: "toolResult",
		toolCallId: "read",
		toolName: "read",
		content: [{ type: "text", text: "file" }],
		isError: false,
		timestamp: Date.now(),
	} as const;
	const ledger = new UsageLedger();
	const billed = ledger.apply(message as any, [], manager.list())!;
	assert.equal((billed as any).usage.cost.total, 0.5);
	assert.deepEqual(billed.subagentsExAccounting?.taskIds, [task.id]);
	for (let read = 0; read < 3; read++) {
		manager.get(task.id);
		assert.equal(ledger.apply(message as any, [], manager.list()), undefined);
	}
	const entries = [{ type: "message", message: billed }];
	assert.equal(new UsageLedger().apply(message as any, entries, manager.list()), undefined);
});

test("additional accounting on a message preserves existing usage and cumulative markers", async () => {
	const manager = new TaskManager();
	const one = manager.start("single", "one", false, async () => result("ok", 1));
	await one.done;
	const message = {
		role: "assistant",
		content: [],
		usage: toModelUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 1 }),
	} as any;
	const ledger = new UsageLedger();
	const billed = ledger.apply(message, [], manager.list())!;
	const two = manager.start("single", "two", false, async () => result("ok", 2));
	await two.done;
	const again = ledger.apply(billed, [], manager.list())!;
	assert.equal((again as any).usage.cost.total, 3.1);
	assert.equal(again.subagentsExAccounting!.usage.cost.total, 3);
	assert.deepEqual(again.subagentsExAccounting!.taskIds, [one.id, two.id]);
});

test("shutdown accounting entries prevent rebilling on child resume", async () => {
	const manager = new TaskManager();
	const task = manager.start("single", "worker", false, async () => result());
	await task.done;
	const ledger = new UsageLedger();
	const marker = ledger.claim([], manager.list())!;
	assert.equal(marker.usage.cost.total, 0.5);
	assert.equal(
		new UsageLedger().claim([{ type: "custom", customType: "subagents-ex-accounting", data: marker }], manager.list()),
		undefined,
	);
});

test("pre-aborted collection returns immediately and does not kill work", async () => {
	const manager = new TaskManager();
	let finish!: () => void;
	const task = manager.start("single", "worker", false, async () => {
		await new Promise<void>((r) => {
			finish = r;
		});
		return result();
	});
	await Promise.resolve();
	await waitForTask(task, 100, AbortSignal.abort());
	assert.equal(task.endedAt, undefined);
	assert.equal(task.controller.signal.aborted, false);
	finish();
	await task.done;
});
