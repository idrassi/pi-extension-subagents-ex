import { temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { distribution, Timings, parseProcessIo, ioDelta } from "../scripts/measurement.ts";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/measure.ts", import.meta.url));

test("measurement quantiles use nearest ranks and preserve missing observations", () => {
	assert.deepEqual(distribution([]), { count: 0, min: null, p50: null, p95: null, max: null });
	assert.deepEqual(distribution([null, undefined, NaN, Infinity, -1, 9, 1, 2, 3]), { count: 4, min: 1, p50: 2, p95: 9, max: 9 });
	assert.equal(distribution(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
});

test("measurement timing pairs attempts, ignores duplicate first-token events, and uses final settlement", () => {
	const timings = new Timings();
	for (const event of [
		{ type: "queued", at: 0 }, { type: "admitted", at: 10 },
		{ type: "spawned", at: 20, attempt: 1 }, { type: "prompt_sent", at: 40, attempt: 1 },
		{ type: "prompt_accepted", at: 50, attempt: 1 }, { type: "first_token", at: 55, attempt: 1 },
		{ type: "first_token", at: 90, attempt: 1 }, { type: "settled", at: 100, attempt: 1 },
		{ type: "spawned", at: 120, attempt: 2 }, { type: "prompt_sent", at: 140, attempt: 2 },
		{ type: "prompt_accepted", at: 150, attempt: 2 }, { type: "settled", at: 200, attempt: 2 },
		{ type: "finished", at: 220 },
	] as const) timings.observe({ ...event, runId: "run-timing" });
	assert.deepEqual(timings.results(), [{ runId: "run-timing", queueWaitMs: 10, completionDeliveryMs: 20,
		attempts: [{ attempt: 1, startupMs: 30, firstTokenMs: 15 }, { attempt: 2, startupMs: 30, firstTokenMs: null }] }]);
	const incomplete = new Timings();
	incomplete.observe({ runId: "run-cancelled", type: "queued", at: 5 });
	incomplete.observe({ runId: "run-cancelled", type: "finished", at: 8 });
	assert.deepEqual(incomplete.results(), [{ runId: "run-cancelled", queueWaitMs: null, completionDeliveryMs: null, attempts: [] }]);
});

test("Linux IO parsing and deltas reject unsupported, partial, or decreasing samples", () => {
	assert.deepEqual(parseProcessIo("rchar: 100\nwchar: 20\nread_bytes: 0\nwrite_bytes: 4096\n"), { rchar: 100, wchar: 20, readBytes: 0, writeBytes: 4096 });
	assert.equal(parseProcessIo("rchar: 12"), null);
	assert.equal(parseProcessIo("rchar: -1\nwchar: 0\nread_bytes: 0\nwrite_bytes: 0"), null);
	assert.equal(ioDelta(null, null), null);
	assert.deepEqual(ioDelta({ rchar: 1, wchar: 2, readBytes: 0, writeBytes: 0 }, { rchar: 4, wchar: 9, readBytes: 0, writeBytes: 4096 }),
		{ rchar: 3, wchar: 7, readBytes: 0, writeBytes: 4096 });
	assert.equal(ioDelta({ rchar: 10, wchar: 0, readBytes: 0, writeBytes: 0 }, { rchar: 1, wchar: 0, readBytes: 0, writeBytes: 0 }), null);
});

test("offline measurement CLI rejects real-model flags and invalid workload sizes before execution", async () => {
	await assert.rejects(execute(process.execPath, [script, "--model", "paid/provider"]), /Unknown option/);
	await assert.rejects(execute(process.execPath, [script, "--repeats", "0"]), /repeats must/);
	await assert.rejects(execute(process.execPath, [script, "--fanout", "999"]), /fanout must/);
	await assert.rejects(execute(process.execPath, [script, "--scenarios", "single,single"]), /unique subset/);
});

test("failed offline measurements preserve completed rows and state before private configuration cleanup", { timeout: 30000 }, async () => {
	const out = path.join(temp, "failed-measurements"), configLog = path.join(temp, "failed-config-path");
	await assert.rejects(execute(process.execPath, ["--import", new URL("./fixtures/measurement-failure.mjs", import.meta.url).href,
		script, "--out", out, "--repeats", "1", "--scenarios", "single,parked"], {
		timeout: 25000, env: { ...process.env, MEASURE_TEST_REQUEST_LOG: path.join(out, "requests.jsonl"), MEASURE_TEST_CONFIG_LOG: configLog },
	}), /EACCES: injected measurement/);
	const failure = JSON.parse(fs.readFileSync(path.join(out, "failure.json"), "utf8"));
	assert.equal(failure.paidRequests, false);
	assert.equal(failure.rows.length, 1);
	assert.equal(failure.rows[0].scenario, "single");
	assert.equal(failure.rows[0].accounting.matches, true);
	assert.match(failure.error, /EACCES: injected measurement/);
	assert.ok(fs.existsSync(path.join(out, "state", "runs")));
	assert.ok(!fs.existsSync(fs.readFileSync(configLog, "utf8")), "the private configuration must be removed even on failure");
	assert.ok(!fs.existsSync(path.join(out, "summary.json")), "failure must not publish a successful summary");
	assert.ok(!fs.existsSync(path.join(out, "state", "auth.json")));
});

test("offline measurements exercise actual pi streaming, admission queues and parked workers", { timeout: 60000 }, async () => {
	const out = path.join(temp, "measurements");
	const result = await execute(process.execPath, [script, "--out", out, "--repeats", "1", "--fanout", "3"], { timeout: 55000 });
	assert.match(result.stdout, /Measurement report:/);
	const report = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
	assert.equal(report.offline, true);
	assert.equal(report.paidRequests, false);
	assert.match(report.environment.sdkVersion, /^\d+\.\d+\.\d+/);
	assert.deepEqual(report.parameters.scenarios, ["single", "fanout", "parked"]);
	assert.equal(report.rows.length, 3);
	for (const row of report.rows) {
		assert.ok(row.runs.every((run: any) => run.status === "ok"));
		assert.equal(row.accounting.matches, true);
		assert.equal(row.remainingRequests, 0);
		assert.equal(row.remainingLeases, 0);
		assert.equal(row.peakRequests, 1);
		assert.ok(row.latencyMs.startup.count > 0);
		assert.ok(row.latencyMs.firstToken.count > 0);
		assert.ok(row.latencyMs.completionDelivery.count > 0);
		assert.ok(row.eventLoopDelayMs.count > 0);
		assert.deepEqual(row.samplingErrors, []);
		if (process.platform === "linux") {
			assert.ok(row.dispatcherIo);
			assert.ok(row.workerMemory.some((worker: any) => worker.activePeakRssBytes > 0));
			assert.ok(row.workerIo.some((worker: any) => worker.counters.rchar > 0 && worker.counters.wchar > 0));
			for (const run of row.runs) assert.ok(row.workerIo.some((worker: any) => worker.runId === run.id && worker.settlementObserved));
		} else {
			assert.equal(row.dispatcherIo, null);
			assert.deepEqual(row.workerIo, []);
		}
	}
	assert.ok(report.rows.find((row: any) => row.scenario === "fanout").latencyMs.queueWait.max > 0);
	if (process.platform === "linux") assert.ok(report.rows.find((row: any) => row.scenario === "parked").workerMemory.some((worker: any) => worker.parkedSamples > 0 && worker.parkedPeakRssBytes > 0));
	assert.ok(fs.existsSync(path.join(out, "state", "runs")));
	assert.ok(!fs.existsSync(path.join(out, "auth.json")));
	assert.ok(!fs.existsSync(path.join(out, "state", "auth.json")));
});
