import { defaults, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHistoryTools } from "../src/history-tools.ts";
import { resultFor } from "../src/orchestrator.ts";
import { TaskManager, taskSummary } from "../src/tasks.ts";
import { saveRun, STATE_DIR } from "../src/store.ts";
import { emptyUsage, newRunRecord } from "../src/types.ts";

function result(cost = 0.5) {
	const run = newRunRecord(`run-${randomUUID()}`, "worker", "user", "task", defaults.cwd);
	run.usage = { ...emptyUsage(), cost, input: 10 };
	run.status = "ok";
	return resultFor({ mode: "single", status: "ok", results: [run], agentScope: "user", projectAgentsDir: null });
}
function toolsFixture() {
	const tools = new Map<string, any>();
	registerHistoryTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
	return tools;
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("task pages are stable, bounded summaries and settled bodies hydrate only on demand", async () => {
	const manager = new TaskManager(randomUUID());
	const tasks = Array.from({ length: 31 }, () => manager.start("single", "worker", false, async () => result()));
	await Promise.all(tasks.map((task) => task.done));
	assert.ok(manager.list().every((task) => task.result === undefined));
	assert.equal(manager.get(tasks[0].id)?.result?.details.results.length, 1);
	const ids = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = manager.page({ cursor, limit: 7 });
		assert.ok(page.tasks.length <= 7);
		for (const task of page.tasks) {
			assert.equal(ids.has(task.id), false);
			ids.add(task.id);
			const summary = taskSummary(task);
			assert.equal("result" in summary, false);
			assert.equal(summary.runIds.length, 1);
		}
		cursor = page.nextCursor;
	} while (cursor);
	assert.equal(ids.size, 31);
	assert.throws(() => manager.page({ cursor: "invalid" }), /cursor/);
	assert.throws(() => manager.page({ limit: 21 }), /limit/);
});

test("task progress saves are coalesced and settlement flushes without a late timer overwrite", async () => {
	const session = randomUUID();
	const manager = new TaskManager(session);
	let finish!: () => void;
	const waiting = new Promise<void>((resolve) => { finish = resolve; });
	const task = manager.start("single", "coalesced", false, async (_signal, update) => {
		for (let i = 0; i < 100; i++) update(result(i / 100));
		await waiting;
		return result(1);
	});
	await Promise.resolve();
	const file = path.join(STATE_DIR, "tasks", createHash("sha256").update(session).digest("hex"), `${task.id}.json`);
	assert.equal(task.usage.cost, 0.99, "live progress does not wait for disk");
	assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).usage.cost < 0.99, "burst must not rewrite all progress snapshots");
	finish();
	await task.done;
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).usage.cost, 1);
	const stamp = fs.statSync(file).mtimeMs;
	await delay(160);
	assert.equal(fs.statSync(file).mtimeMs, stamp, "settlement clears the pending progress write");
	assert.equal(new TaskManager(session).get(task.id)?.usage.cost, 1);
});

test("output tool paging preserves all bytes across line caps and Unicode without charging usage", async () => {
	const tools = toolsFixture();
	const run = newRunRecord(`run-${randomUUID()}`, "worker", "user", "bulk", temp);
	const output = "\n".repeat(2000) + "£🧪\"\\\n".repeat(1700);
	run.status = "ok";
	run.endedAt = Date.now();
	run.messages = [{ role: "assistant", content: [{ type: "text", text: output }], api: "test", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now() }];
	saveRun(run);
	const tool = tools.get("subagent_run_output");
	let offset = 0;
	let restored = "";
	for (let i = 0; i < 100; i++) {
		const page = await tool.execute("page", { id: run.id, offset }, undefined, undefined, {});
		assert.ok(size(page) <= 64 * 1024);
		assert.equal("usage" in page, false);
		const text = page.content[0].text as string;
		assert.ok(text.split("\n").length <= 1000);
		restored += text.slice(text.indexOf("\n") + 1);
		if (page.details.nextOffset === undefined) break;
		assert.ok(page.details.nextOffset > offset);
		offset = page.details.nextOffset;
	}
	assert.equal(restored, output);
	await assert.rejects(() => tool.execute("page", { id: run.id, limit: 4097 }), /limit/);
});

test("history pages shrink before publication rather than skipping escaped oversized summaries", async () => {
	const tools = toolsFixture();
	const marker = randomUUID();
	const expected = new Set<string>();
	for (let i = 0; i < 60; i++) {
		const run = newRunRecord(`run-${marker}-${i}`, "\u0001".repeat(128), "user", "\u0002".repeat(256), temp);
		run.status = "ok";
		run.endedAt = Date.now();
		run.startedAt = 9_000_000_000_000 + i;
		run.endedAt = run.startedAt + 10;
		expected.add(run.id);
		saveRun(run);
	}
	let cursor: string | undefined;
	const seen = new Set<string>();
	for (let i = 0; i < 100; i++) {
		const page = await tools.get("subagent_history").execute("history", { cursor, limit: 50 });
		assert.ok(size(page) <= 64 * 1024);
		for (const run of page.details.runs) {
			assert.equal(seen.has(run.id), false);
			seen.add(run.id);
		}
		cursor = page.details.nextCursor;
		if (!cursor) break;
	}
	assert.ok([...expected].every((id) => seen.has(id)), "published cursors must not skip summaries trimmed by the envelope budget");
});
