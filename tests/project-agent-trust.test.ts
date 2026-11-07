import { agent as userAgent, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agents.ts";
import subagentsExtension from "../src/index.ts";
import { ProjectAgentTrust } from "../src/project-agent-trust.ts";
import { saveRun } from "../src/store.ts";
import { newRunRecord } from "../src/types.ts";

// Exercise the host's actual resolver, not a mock returning false. This internal
// module is intentionally test-only; authorization uses no private host APIs.
const { resolveProjectTrusted } = await import(
	new URL("./core/project-trust.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);

function context(cwd = temp, hasUI = true, confirmed = true) {
	let sessionId = randomUUID();
	const confirmations: { title: string; message: string }[] = [];
	const otherUI: string[] = [];
	const ctx = {
		cwd,
		hasUI,
		mode: hasUI ? "rpc" : "print",
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
		ui: {
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return confirmed;
			},
			notify: () => { otherUI.push("notify"); },
			setWidget: () => { otherUI.push("setWidget"); },
		},
	} as unknown as ExtensionContext;
	return { ctx, confirmations, otherUI, setSession: (id = randomUUID()) => { sessionId = id; } };
}

function extensionFixture(cwd: string, hasUI: boolean, approved: boolean) {
	const f = context(cwd, hasUI, approved);
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const effects: string[] = [];
	subagentsExtension({
		on: (name: string, fn: Function) => handlers.set(name, fn),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendMessage: () => effects.push("sendMessage"),
		appendEntry: () => effects.push("appendEntry"),
	} as any);
	const prompt = async () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handlers.get("before_agent_start")!(event, f.ctx);
		return event.systemPromptOptions.sections.subagents;
	};
	const execute = (params: Record<string, unknown>, signal?: AbortSignal) => tools.get("subagent").execute(
		"call", params, signal, undefined, f.ctx,
	);
	return { ...f, tools, commands, handlers, effects, prompt, execute, shutdown: () => handlers.get("session_shutdown")!() };
}

function repo() {
	const cwd = fs.mkdtempSync(path.join(temp, "trust-project-"));
	execFileSync("git", ["init", "--quiet", cwd]);
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	return cwd;
}
function definition(cwd: string, name: string, description = "unapproved project description", extra = "", body = "work") {
	const file = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`);
	return file;
}
function projectAgent(): AgentConfig {
	return { ...userAgent, source: "project", filePath: path.join(temp, ".pi", "agents", "test.md") };
}
function filesInAgentDir() {
	return fs.readdirSync(getAgentDir(), { recursive: true }).sort();
}
async function hostTrust(cwd: string, store: ProjectTrustStore, options: Record<string, unknown> = {}) {
	return resolveProjectTrusted({
		cwd,
		trustStore: store,
		defaultProjectTrust: "never",
		projectTrustContext: {
			cwd, mode: "print", hasUI: false,
			ui: new Proxy({}, { get: () => () => { throw new Error("Host must not prompt"); } }),
		},
		...options,
	});
}

test("actual host trust in an agents-only repo is implicitly true, but cannot authorize execution or prompt exposure", async () => {
	const cwd = repo();
	definition(cwd, "project-only", "REPOSITORY_PROMPT_INJECTION");
	const store = new ProjectTrustStore(path.join(temp, `trust-store-${randomUUID()}`));
	assert.equal(hasTrustRequiringProjectResources(cwd), false);
	assert.equal(store.get(cwd), null);
	const effectiveTrust = await hostTrust(cwd, store);
	assert.equal(effectiveTrust, true, "reproduces the host's implicit-trust branch despite default never");

	for (const hasUI of [false, true]) {
		const f = extensionFixture(cwd, hasUI, false);
		f.ctx.isProjectTrusted = () => effectiveTrust;
		const before = filesInAgentDir();
		try {
			const prompt = await f.prompt();
			assert.doesNotMatch(prompt, /REPOSITORY_PROMPT_INJECTION|project-only/);
			assert.equal(f.confirmations.length, 0, "discovery must not request approval");
			for (const params of [
				{ agent: "project-only", task: "work", runInBackground: true, isolation: "worktree" },
				{ tasks: [{ agent: "project-only", task: "work" }] },
				{ chain: [{ agent: "project-only", task: "work" }] },
			]) {
				const result = await f.execute({ ...params, agentScope: "both", confirmProjectAgents: false });
				assert.equal(result.details.status, "error");
				assert.match(result.content[0].text, /approval|approved/);
				assert.deepEqual(result.details.results, []);
				assert.doesNotMatch(JSON.stringify(result), /REPOSITORY_PROMPT_INJECTION/);
			}
			assert.equal(f.confirmations.length, hasUI ? 3 : 0);
			assert.deepEqual(f.otherUI, []);
			assert.deepEqual(f.effects, []);
			assert.deepEqual(filesInAgentDir(), before, "no tasks, runs, worktrees, or approvals may be persisted");
		} finally {
			await f.shutdown();
		}
	}
});

test("saved, CLI, and default host trust still require definition approval when provenance is unavailable", async () => {
	const cwd = repo();
	definition(cwd, "project-only");
	const store = new ProjectTrustStore(path.join(temp, `trust-store-${randomUUID()}`));
	store.set(cwd, true);
	assert.equal(await hostTrust(cwd, store), true);
	store.set(cwd, null);
	assert.equal(await hostTrust(cwd, store, { trustOverride: true }), true);
	fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "{}");
	assert.equal(hasTrustRequiringProjectResources(cwd), true);
	assert.equal(await hostTrust(cwd, store, { defaultProjectTrust: "always" }), true);
	// A global saved decision cannot identify the active SDK host's trust store.
	new ProjectTrustStore(getAgentDir()).set(cwd, true);
	const f = extensionFixture(cwd, false, true);
	try {
		const result = await f.execute({ agent: "project-only", task: "work", agentScope: "project" });
		assert.match(result.content[0].text, /per-definition approval/);
		assert.equal(f.confirmations.length, 0);
		assert.doesNotMatch(await f.prompt(), /unapproved project description/);
	} finally {
		await f.shutdown();
	}
});

test("discovery and registered metadata do not prompt, and unauthorized overrides preserve bundled/user fallbacks", async () => {
	const cwd = repo();
	definition(cwd, "reviewer", "UNAPPROVED_BUNDLED_OVERRIDE");
	definition(cwd, "personal", "UNAPPROVED_USER_OVERRIDE");
	definition(cwd, "invalid", "INVALID_PROJECT_DESCRIPTION", "maxTurns: INVALID_PROJECT_PARSE_TEXT\n");
	const userDir = path.join(getAgentDir(), "agents");
	fs.mkdirSync(userDir, { recursive: true });
	const userFile = path.join(userDir, "personal.md");
	fs.writeFileSync(userFile, "---\nname: personal\ndescription: trusted user description\n---\nwork");
	const f = extensionFixture(cwd, true, true);
	const before = filesInAgentDir();
	try {
		assert.ok(JSON.stringify(Array.from(f.tools.values())).includes("per-definition session confirmation"));
		for (const command of f.commands.values()) command.getArgumentCompletions?.("");
		f.handlers.get("resources_discover")!({}, f.ctx);
		const prompt = await f.prompt();
		assert.match(prompt, /reviewer \(bundled\)/);
		assert.match(prompt, /personal \(user\): trusted user description/);
		assert.doesNotMatch(prompt, /UNAPPROVED_|INVALID_PROJECT_|invalid.md/);
		assert.equal(f.confirmations.length, 0);
		assert.deepEqual(f.otherUI, []);
		assert.deepEqual(f.effects, []);
		assert.deepEqual(filesInAgentDir(), before);
	} finally {
		await f.shutdown();
		fs.rmSync(userFile);
	}
});

test("execution and discovery share the same approval for exactly the loaded snapshot", async () => {
	const cwd = repo();
	const file = definition(cwd, "selected", "SELECTED_APPROVED_DESCRIPTION");
	definition(cwd, "not-selected", "UNSELECTED_DESCRIPTION");
	const f = extensionFixture(cwd, true, true);
	// Stop after authorization without starting a child/provider or worktree.
	const params = { agent: "selected", task: "work", agentScope: "both", cwd: "missing-directory" };
	try {
		for (let i = 0; i < 2; i++) {
			const result = await f.execute(params);
			assert.match(result.content[0].text, /ENOENT/);
		}
		assert.equal(f.confirmations.length, 1);
		assert.match(f.confirmations[0].message, /SHA-256: [a-f0-9]{64}/);
		assert.match(f.confirmations[0].message, new RegExp(path.basename(file)));
		let prompt = await f.prompt();
		assert.match(prompt, /SELECTED_APPROVED_DESCRIPTION/);
		assert.doesNotMatch(prompt, /UNSELECTED_DESCRIPTION/);
		definition(cwd, "selected", "CHANGED_UNAPPROVED_DESCRIPTION");
		prompt = await f.prompt();
		assert.doesNotMatch(prompt, /SELECTED_APPROVED_DESCRIPTION|CHANGED_UNAPPROVED_DESCRIPTION/);
		assert.equal(f.confirmations.length, 1, "changed discovery must not prompt");
		await f.execute(params);
		assert.equal(f.confirmations.length, 2);
		f.setSession();
		assert.doesNotMatch(await f.prompt(), /CHANGED_UNAPPROVED_DESCRIPTION/);
		await f.execute(params);
		assert.equal(f.confirmations.length, 3, "approval must not survive session replacement");
		const reloaded = extensionFixture(cwd, false, true);
		try {
			const result = await reloaded.execute(params);
			assert.match(result.content[0].text, /per-definition approval/);
		} finally {
			await reloaded.shutdown();
		}
	} finally {
		await f.shutdown();
	}
});

test("resuming a saved project run cannot restore or bypass authorization", async () => {
	const cwd = repo();
	definition(cwd, "saved-agent", "SAVED_PROJECT_DESCRIPTION");
	const saved = newRunRecord(`run-${randomUUID()}`, "saved-agent", "project", "previous work", cwd);
	saved.status = "ok";
	saved.endedAt = Date.now();
	saved.sessionFile = path.join(temp, "saved-child-session.jsonl");
	saveRun(saved);
	const f = extensionFixture(cwd, false, true);
	const before = filesInAgentDir();
	try {
		const result = await f.execute({ resume: saved.id, task: "follow up", agentScope: "both" });
		assert.equal(result.details.status, "error");
		assert.match(result.content[0].text, /per-definition approval/);
		assert.doesNotMatch(await f.prompt(), /SAVED_PROJECT_DESCRIPTION/);
		assert.equal(f.confirmations.length, 0);
		assert.deepEqual(filesInAgentDir(), before);
	} finally {
		await f.shutdown();
	}
});

test("approval hashes include every execution field, metadata, and source path, but not object key order", async () => {
	const trust = new ProjectAgentTrust();
	const f = context();
	const original = projectAgent();
	await trust.authorize([original, { ...original }], f.ctx);
	assert.equal(f.confirmations.length, 1, "duplicate selected snapshots need only one confirmation");
	const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as AgentConfig;
	assert.equal(trust.isAuthorized(reordered, f.ctx), true);
	for (const patch of [
		{ name: "other" }, { description: "other" }, { systemPrompt: "other" }, { filePath: "elsewhere.md" },
		{ model: "provider/other" }, { thinking: "high" as const }, { tools: ["read"] }, { excludeTools: ["bash"] },
		{ skills: true }, { contextFiles: true }, { extensions: true }, { maxTurns: 2 }, { timeoutSeconds: 3 }, { retries: 1 },
	]) {
		assert.equal(trust.isAuthorized({ ...original, ...patch }, f.ctx), false, JSON.stringify(patch));
	}
	await trust.authorize([{ ...original }], f.ctx);
	assert.equal(f.confirmations.length, 1);
	f.ctx.hasUI = false;
	await trust.authorize([original], f.ctx);
	f.setSession();
	await assert.rejects(trust.authorize([original], f.ctx), /unapproved headless/);
	assert.equal(trust.isAuthorized(original, f.ctx), false);
	assert.equal(new ProjectAgentTrust().isAuthorized(original, context().ctx), false);
});

test("active host distrust does not waive confirmation, but an explicit definition approval remains usable", async () => {
	const cwd = repo();
	const store = new ProjectTrustStore(path.join(temp, `trust-store-${randomUUID()}`));
	const effectiveTrust = await hostTrust(cwd, store, { trustOverride: false });
	assert.equal(effectiveTrust, false);
	const f = context(cwd);
	f.ctx.isProjectTrusted = () => effectiveTrust;
	const trust = new ProjectAgentTrust();
	const selected = projectAgent();
	assert.equal(trust.isAuthorized(selected, f.ctx), false);
	await trust.authorize([selected], f.ctx);
	assert.equal(f.confirmations.length, 1);
	assert.equal(trust.isAuthorized(selected, f.ctx), true);
});

test("denial, dismissal, and UI errors fail closed without caching approval", async () => {
	for (const outcome of [false, undefined, "yes", new Error("UI unavailable")]) {
		const trust = new ProjectAgentTrust();
		const f = context();
		const selected = projectAgent();
		f.ctx.ui.confirm = async () => {
			if (outcome instanceof Error) throw outcome;
			return outcome as boolean;
		};
		await assert.rejects(trust.authorize([selected], f.ctx));
		assert.equal(trust.isAuthorized(selected, f.ctx), false);
	}
});

test("aborts, session changes, and definition mutation while UI is pending cannot authorize a run", async () => {
	for (const change of ["abort", "session", "definition"] as const) {
		const trust = new ProjectAgentTrust();
		const f = context();
		const selected = projectAgent();
		const original = { ...selected };
		const controller = new AbortController();
		f.ctx.ui.confirm = async () => {
			if (change === "abort") controller.abort();
			if (change === "session") f.setSession();
			if (change === "definition") selected.systemPrompt = "not approved";
			return true;
		};
		await assert.rejects(trust.authorize([selected], f.ctx, controller.signal));
		assert.equal(trust.isAuthorized(selected, f.ctx), false);
		assert.equal(trust.isAuthorized(original, f.ctx), false);
	}
});
