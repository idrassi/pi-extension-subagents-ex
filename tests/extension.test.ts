import { temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import subagentsExtension from "../src/index.ts";

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
