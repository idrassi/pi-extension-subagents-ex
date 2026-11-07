import { temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import subagentsExtension from "../src/index.ts";
import { STATE_DIR } from "../src/store.ts";
import { emptyUsage } from "../src/types.ts";

function fixture(hasUI = false, approved = false) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sessionId = randomUUID();
	let confirmations = 0;
	const pi = {
		on: (name: string, fn: Function) => handlers.set(name, fn),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendMessage() {},
		appendEntry() {},
	};
	const ctx = {
		cwd: temp,
		hasUI,
		mode: "rpc",
		isProjectTrusted: () => false,
		isIdle: () => true,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
		ui: {
			setWidget() {},
			notify(_message: string) {},
			confirm: async () => {
				confirmations++;
				return approved;
			},
		},
	};
	subagentsExtension(pi as any);
	return { handlers, tools, commands, ctx, confirmations: () => confirmations };
}

test("project trust cannot be bypassed by a model flag or headless execution", async () => {
	const dir = path.join(temp, ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "project-only.md"), "---\nname: project-only\ndescription: project agent\n---\nwork");
	for (const hasUI of [false, true]) {
		const f = fixture(hasUI, false);
		const result = await f.tools
			.get("subagent")
			.execute(
				"id",
				{ agent: "project-only", task: "work", agentScope: "both", confirmProjectAgents: false },
				undefined,
				undefined,
				f.ctx,
			);
		assert.equal(result.details.status, "error");
		assert.match(result.content[0].text, /approval|approved/);
		assert.equal(f.confirmations(), hasUI ? 1 : 0);
		await f.handlers.get("session_shutdown")!();
	}
});

test("off policy removes proactive guidance from both system section and tool definition", async () => {
	const f = fixture();
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	await f.handlers.get("before_agent_start")!(event, f.ctx);
	assert.ok(event.systemPromptOptions.sections.subagents);
	await f.commands.get("agents-policy").handler("off", f.ctx);
	await f.handlers.get("before_agent_start")!(event, f.ctx);
	assert.equal(event.systemPromptOptions.sections.subagents, undefined);
	assert.equal(f.tools.get("subagent").promptGuidelines, undefined);
	await f.handlers.get("session_shutdown")!();
});

test("failed structured results are marked as tool errors via pi's result hook", async () => {
	const f = fixture();
	assert.deepEqual(f.handlers.get("tool_result")!({ toolName: "subagent", details: { status: "error" } }), {
		isError: true,
	});
	assert.equal(f.handlers.get("tool_result")!({ toolName: "subagent", details: { status: "ok" } }), undefined);
	assert.deepEqual(
		f.handlers.get("tool_result")!({ toolName: "subagent_task_output", details: { task: { status: "killed" } } }),
		{ isError: true },
	);
});

test("thrown retrieval errors are bounded at publication with original SDK usage", async () => {
	const f = fixture();
	const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
		cost: { input: 0.007, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
	try {
		for (const [name, id] of [["subagent_task_output", "🧪\\\"\n".repeat(20000)], ["subagent_run_output", `run-${"a".repeat(100000)}`]]) {
			let error: unknown;
			try { await f.tools.get(name).execute("read", { id }, undefined, undefined, f.ctx); }
			catch (caught) { error = caught; }
			assert.ok(error instanceof Error);
			const published = f.handlers.get("tool_result")!({ toolName: name, isError: true,
				content: [{ type: "text", text: error.message }], details: { diagnostic: "\u0001".repeat(100000) }, usage });
			assert.ok(published, "the tool-result boundary must bound thrown errors too");
			assert.equal(published.isError, true);
			assert.deepEqual(published.usage, usage);
			assert.ok(Buffer.byteLength(JSON.stringify({ content: published.content, details: published.details, usage: published.usage })) <= 64 * 1024);
			assert.ok(Buffer.byteLength(published.content[0].text) <= 32 * 1024);
			assert.match(published.content[0].text, /truncat|omitted/i);
		}
	} finally { await f.handlers.get("session_shutdown")!(); }
});

test("task-list tool publishes bounded pages without skipping summaries or losing run IDs", async () => {
	const f = fixture();
	const session = f.ctx.sessionManager.getSessionId();
	const dir = path.join(STATE_DIR, "tasks", createHash("sha256").update(session).digest("hex"));
	fs.mkdirSync(dir, { recursive: true });
	const expected = new Set<string>();
	for (let i = 0; i < 35; i++) {
		const id = `task-${randomUUID()}`;
		expected.add(id);
		fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
			id, kind: "parallel", label: "\u0001".repeat(128), summary: "\u0002".repeat(256), status: "done",
			startedAt: 1000, endedAt: 2000, notify: false, usage: emptyUsage(), owner: { sessionId: session },
			runIds: Array.from({ length: 32 }, () => `run-${randomUUID()}`),
		}));
	}
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await f.tools.get("subagent_task_list").execute("list", { cursor, limit: 20 }, undefined, undefined, f.ctx);
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024);
		assert.ok(page.details.tasks.length < 20, "oversized summaries require a smaller actual page");
		for (const task of page.details.tasks) {
			assert.equal(seen.has(task.id), false);
			seen.add(task.id);
			assert.equal("result" in task, false);
			assert.equal(task.runIds.length, 32);
		}
		cursor = page.details.nextCursor;
	} while (cursor);
	assert.deepEqual(seen, expected);
	await f.handlers.get("session_shutdown")!();
});

test("budget command displays unlimited defaults without losing totals", async () => {
	const f = fixture();
	let text = "";
	f.ctx.ui.notify = (message: string) => {
		text = message;
	};
	await f.commands.get("agents-budget").handler("", f.ctx);
	assert.match(text, /0\/20 active, 0\/unlimited runs, 0\/unlimited turns, \$0\.0000/);
	await f.handlers.get("session_shutdown")!();
});
