import { agent, defaults, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { newRunRecord } from "../src/types.ts";
import { loadRunById, saveRun, STATE_DIR } from "../src/store.ts";
import { TaskManager, serializeTask } from "../src/tasks.ts";
import { buildPlan } from "../src/plan.ts";
import { writeJson } from "../src/files.ts";

test("interrupted task snapshots recover without relaunching work", async () => {
	const sessionId = randomUUID();
	const manager = new TaskManager(sessionId);
	const task = manager.start("single", "worker", false, async () => ({
		content: [],
		details: { mode: "single", status: "ok", results: [], agentScope: "user", projectAgentsDir: null },
	}));
	await task.done;
	const file = path.join(STATE_DIR, "tasks", createHash("sha256").update(sessionId).digest("hex"), `${task.id}.json`);
	writeJson(file, { ...serializeTask(task), status: "running", endedAt: undefined });
	const restored = new TaskManager(sessionId).get(task.id)!;
	assert.equal(restored.status, "interrupted");
	assert.ok(restored.endedAt);
	assert.match(restored.errorMessage!, /resume explicitly/);
});

test("dead dispatcher/child records become resumable interrupted runs; live owners remain protected", () => {
	const run = newRunRecord(`run-${randomUUID()}`, "test", "user", "task", defaults.cwd);
	run.ownerPid = 2147483647; // outside the OS PID range
	run.childPid = 2147483646;
	run.status = "running";
	run.sessionFile = path.join(temp, "saved-session.jsonl");
	fs.writeFileSync(run.sessionFile, "");
	saveRun(run);
	const interrupted = loadRunById(run.id)!;
	assert.equal(interrupted.status, "interrupted");
	const plan = buildPlan({ resume: run.id, task: "continue" }, [agent], defaults, null, interrupted);
	assert.equal(plan.resumeFrom?.id, run.id);
	run.ownerPid = process.pid;
	saveRun(run);
	const active = loadRunById(run.id)!;
	assert.equal(active.status, "running");
	assert.throws(() => buildPlan({ resume: run.id, task: "continue" }, [agent], defaults, null, active), /settled run/);
});
