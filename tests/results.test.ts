import { temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { aggregateUsage, toModelUsage } from "../src/format.ts";
import { resultFor } from "../src/orchestrator.ts";
import { renderSubagentResult } from "../src/render.ts";
import {
	boundedResult, compactDetails, compactRun, MAX_RESULT_BYTES, MAX_RESULT_DETAILS_BYTES,
	MAX_RESULT_TEXT_BYTES, MAX_RESULT_TEXT_LINES, MAX_RUN_OUTPUT_BYTES,
} from "../src/results.ts";
import { newRunRecord, type RunRecord, type RunResult, type SubagentDetails } from "../src/types.ts";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };

function run(index = 0, output = "complete"): RunRecord {
	const record = newRunRecord(`run-${index}-🧪`, "test", "user", "task", temp);
	record.treeId = `tree-${index}-日本語`;
	record.parentRunId = "parent";
	record.resumeOf = "original";
	record.startedAt = 123;
	record.status = "ok";
	record.attempts = 2;
	record.usage = { input: index + 1, output: index + 2, cacheRead: index + 3, cacheWrite: index + 4,
		cost: index / 100, contextTokens: index + 5, turns: index + 6 };
	record.messages = [{ role: "assistant", content: [{ type: "text", text: output }],
		api: "openai-completions", model: "fixture", provider: "fixture", usage: toModelUsage(record.usage),
		stopReason: "stop", timestamp: 123 } as Message];
	return record;
}

function details(results: RunRecord[] | RunResult[]): SubagentDetails {
	return { mode: results.length === 1 ? "single" : "parallel", agentScope: "user", projectAgentsDir: null,
		status: "ok", results };
}

function assertBounded(result: ReturnType<typeof boundedResult>) {
	assert.ok(bytes(result) <= MAX_RESULT_BYTES, `${bytes(result)} serialized bytes`);
	assert.ok(bytes(result.details) <= MAX_RESULT_DETAILS_BYTES);
	const text = result.content[0];
	assert.equal(text.type, "text");
	if (text.type !== "text") return;
	assert.ok(Buffer.byteLength(text.text) <= MAX_RESULT_TEXT_BYTES);
	assert.ok(text.text.split("\n").length <= MAX_RESULT_TEXT_LINES);
	assert.ok(!text.text.includes("�"), "must not split a UTF-8 character");
	assert.equal(text.text, Buffer.from(text.text).toString("utf8"), "must not leave a split surrogate");
}

test("small bounded results keep details, text, and SDK usage unchanged", () => {
	const usage = toModelUsage(run().usage);
	const source = { status: "ok", page: 1, items: ["hello", "日本語 🧪"] };
	const result = boundedResult("hello", source, usage);
	assert.deepEqual(result.details, source);
	assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
	assert.equal(result.usage, usage);
	assertBounded(result);
});

test("serialized envelope accounts for JSON escapes as well as Unicode and line limits", () => {
	for (const text of ["🙂日本語\0\"\\".repeat(10_000), "🧪\n".repeat(2000), "a".repeat(48 * 1024)]) {
		const result = boundedResult(text, { metadata: "\0".repeat(20_000) });
		assertBounded(result);
		assert.match((result.content[0] as any).text, /Truncated.*subagent_run_output/);
		assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 32 * 1024);
	}
});

test("32 large JSON outputs and long metadata remain compact without losing any provenance or usage", () => {
	const output = JSON.stringify({ payload: "🧪".repeat(12 * 1024) });
	const long = "long-metadata-日本語".repeat(4000);
	const records = Array.from({ length: 32 }, (_, index) => {
		const record = run(index, output);
		record.task = record.errorMessage = record.model = record.stopReason = long;
		record.cwd = record.sessionFile = long;
		record.worktree = { path: long, branch: long, repoRoot: long, baseCommit: long, subdirectory: long };
		record.parsedOutput = { payload: output, nested: { results: [record] } };
		record.outputSchema = { description: long };
		record.artifacts = {
			manifest: "/artifacts/manifest.json", patch: "/artifacts/changes.patch", output: "/artifacts/output.txt",
			changedFiles: Array.from({ length: 100 }, (_, i) => `${i}-${long}`),
			verification: Array.from({ length: 32 }, () => ({ command: long, output: long, exitCode: 0 })),
		};
		// A nested transcript/result graph must not be recursively published.
		record.messages.unshift({ role: "toolResult", toolCallId: "nested", toolName: "wrapper", content: [],
			isError: false, timestamp: 0, details: { results: [record], sentinel: "TRANSCRIPT-ONLY" } } as unknown as Message);
		return record;
	});
	const result = resultFor(details(records));
	assertBounded(result);
	assert.equal(result.details.results.length, 32);
	assert.deepEqual(result.usage, toModelUsage(aggregateUsage(records)));
	assert.equal(result.details.truncated, true);
	for (let i = 0; i < records.length; i++) {
		const published = result.details.results[i];
		assert.equal(published.id, records[i].id);
		assert.equal(published.treeId, records[i].treeId);
		assert.equal(published.parentRunId, records[i].parentRunId);
		assert.equal(published.resumeOf, records[i].resumeOf);
		assert.deepEqual(published.usage, records[i].usage);
		assert.deepEqual(Object.keys(published.usage).sort(), ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"].sort());
		for (const key of ["messages", "stderr", "attemptHistory", "parsedOutput", "outputSchema"])
			assert.equal(Object.hasOwn(published, key), false, key);
		assert.ok(!published.output || Buffer.byteLength(published.output) <= MAX_RUN_OUTPUT_BYTES);
		assert.equal(records[i].messages.length, 2, "publication must not mutate execution records");
		assert.equal(records[i].artifacts?.changedFiles.length, 100);
	}
	assert.ok(!JSON.stringify(result).includes("TRANSCRIPT-ONLY"));
	assert.deepEqual(compactDetails(result.details), result.details);
});

test("raw RunRecord fixtures remain assignable and compact details sanitize legacy snapshots idempotently", () => {
	const raw = run(1, "x".repeat(48 * 1024));
	const compatible: RunResult = raw;
	assert.equal(compatible.id, raw.id);
	raw.artifacts = { output: "/artifacts/output.txt", manifest: "/artifacts/manifest.json", patch: "/artifacts/patch",
		changedFiles: ["src/test.ts"], verification: [{ command: "npm test", output: "VERIFICATION-TRANSCRIPT", exitCode: 0 }] };
	raw.sessionFile = "/sessions/native.jsonl";
	const compact = compactDetails(details([raw]));
	assert.deepEqual(compactDetails(compact), compact);
	assert.notEqual(compact.results[0], raw);
	assert.deepEqual(compact.results[0].usage, raw.usage);
	assert.equal(compact.results[0].artifacts?.output, raw.artifacts.output);
	assert.equal(compact.results[0].sessionFile, raw.sessionFile);
	assert.ok(!JSON.stringify(compact).includes("VERIFICATION-TRANSCRIPT"));
	assert.equal(compact.results[0].outputTruncated, true);
	assert.match(compact.results[0].output!, /Truncated/);
	assert.ok(bytes(compact) <= MAX_RESULT_DETAILS_BYTES);
});

test("legacy task/result wrappers and cyclic unknown details cannot reintroduce transcripts", () => {
	const raw = run(0, "🧪".repeat(20_000));
	const wrapper: any = { task: { id: "task-id", result: { content: [{ type: "text", text: "huge".repeat(20_000) }], details: details([raw]) } } };
	wrapper.cycle = wrapper;
	wrapper.messages = [{ content: "TRANSCRIPT-ONLY".repeat(5000) }];
	const result = boundedResult("task output", wrapper, toModelUsage(raw.usage));
	assertBounded(result);
	const published = result.details.task.result.details.results[0];
	assert.equal(published.id, raw.id);
	assert.equal(published.treeId, raw.treeId);
	assert.deepEqual(published.usage, raw.usage);
	assert.ok(!JSON.stringify(result).includes("TRANSCRIPT-ONLY"));
	assert.match(result.details.cycle, /Circular/);
});

test("generic sanitation preserves all usage fields on legacy provenance-only result entries", () => {
	const records = Array.from({ length: 32 }, (_, i) => run(i));
	const source = { results: records.map((record) => ({ id: record.id, treeId: record.treeId, usage: record.usage,
		...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`metadata-${i}`, "x".repeat(48 * 1024)])),
	})) };
	const result = boundedResult("provenance", source);
	assertBounded(result);
	assert.equal(result.details.results.length, 32);
	for (let i = 0; i < records.length; i++) {
		assert.equal(result.details.results[i].id, records[i].id);
		assert.equal(result.details.results[i].treeId, records[i].treeId);
		assert.deepEqual(result.details.results[i].usage, records[i].usage);
	}
});

test("large error strings and generic detail lists are bounded even when prose is tiny", () => {
	const raw = run(0, "");
	raw.status = "error";
	raw.errorMessage = "💥failed\n".repeat(50_000);
	const result = resultFor({ ...details([raw]), status: "error", errorMessage: raw.errorMessage });
	assertBounded(result);
	assert.equal(result.details.results[0].status, "error");
	assert.deepEqual(result.details.results[0].usage, raw.usage);
	const generic = boundedResult("ok", { items: Array.from({ length: 2000 }, (_, i) => ({ path: `${i}日本語`.repeat(4000) })) });
	assertBounded(generic);
	assert.match((generic.content[0] as any).text, /Truncated/);
});

test("expanded legacy and compact TUI views render previews and refs, never earlier tool transcripts", () => {
	initTheme("dark", false);
	const raw = run(0, `visible preview\n${"x".repeat(48 * 1024)}\nFINAL-TAIL-NOT-IN-PREVIEW`);
	raw.artifacts = { output: "/artifacts/output.txt", patch: "/artifacts/changes.patch", changedFiles: [], verification: [] };
	raw.sessionFile = "/sessions/native.jsonl";
	raw.messages.unshift({ role: "assistant", content: [{ type: "text", text: "EARLIER-TRANSCRIPT".repeat(5000) },
		{ type: "toolCall", id: "private", name: "PRIVATE-TOOL-CALL", arguments: { command: "secret" } }],
		api: "openai-completions", model: "fixture", provider: "fixture", usage: toModelUsage(raw.usage), stopReason: "toolUse", timestamp: 0 } as Message);
	for (const source of [details([raw]), compactDetails(details([raw]))]) {
		for (const expanded of [false, true]) {
			const rendered = renderSubagentResult({ details: source, content: [] }, { expanded }, theme).render(100).join("\n");
			assert.match(rendered, /visible preview/);
			assert.ok(!rendered.includes("EARLIER-TRANSCRIPT"));
			assert.ok(!rendered.includes("PRIVATE-TOOL-CALL"));
			assert.ok(!rendered.includes("FINAL-TAIL-NOT-IN-PREVIEW"));
			if (expanded) {
				assert.match(rendered, /subagent_run_output/);
				assert.match(rendered, /\/artifacts\/output.txt/);
				assert.match(rendered, /\/sessions\/native.jsonl/);
			}
		}
	}
});

test("unbounded identity cores fail explicitly rather than silently corrupting provenance", () => {
	const raw = run();
	raw.id = "identity".repeat(20_000);
	assert.throws(() => compactDetails(details([raw])), /identities and usage exceed/);
	assert.equal(compactRun(raw).id, raw.id);
});
