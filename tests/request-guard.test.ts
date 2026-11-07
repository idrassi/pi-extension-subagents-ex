import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import childGuard from "../src/child-guard.ts";
import { Scheduler } from "../src/scheduler.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(run: (f: {
	scheduler: Scheduler; ctx: any; setIdle: (idle: boolean) => void;
	emit: (name: string, event?: any) => Promise<any>; aborted: () => boolean;
}) => Promise<void>) {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxRequests: 1 });
	const release = await scheduler.acquire("guard-owner");
	const saved = { ...process.env };
	process.env.PI_SUBAGENTS_EX_TREE_ID = scheduler.id;
	process.env.PI_SUBAGENTS_EX_LEASE_ID = "guard-owner";
	process.env.PI_SUBAGENTS_EX_TASK_NAMESPACE = "guard-owner-1";
	process.env.PI_SUBAGENTS_EX_PARENT_PID = "0";
	const handlers = new Map<string, Function[]>();
	let idle = false, aborted = false;
	const ctx = { signal: undefined as AbortSignal | undefined, abort() { aborted = true; },
		isIdle: () => idle, sessionManager: { getEntries: () => [] } };
	childGuard({ on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		registerCommand() {}, appendEntry() {},
	} as any);
	const emit = async (name: string, event: any = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	try { await run({ scheduler, ctx, emit, setIdle: (value) => { idle = value; }, aborted: () => aborted }); }
	finally {
		await emit("session_shutdown");
		(process as any)[Symbol.for("pi-subagents-ex.orphan-guard")]?.();
		await release();
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}

const branch = (signal: AbortSignal) => ({ signal, preparation: { userWantsSummary: true, entriesToSummarize: [{}] } });
async function assertReleased(scheduler: Scheduler) {
	for (let i = 0; i < 30; i++) {
		if (!(await scheduler.snapshot()).requests.length) return;
		await delay(20);
	}
	assert.deepEqual((await scheduler.snapshot()).requests, []);
}

test("ordinary guard admission is idempotent and releases at assistant completion before tools", async () => fixture(async ({ scheduler, emit }) => {
	await Promise.all([emit("context"), emit("before_provider_request"), emit("context")]);
	assert.equal((await scheduler.snapshot()).requests.filter((request) => request.active).length, 1);
	await emit("message_end", { message: { role: "assistant", content: [], stopReason: "aborted",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
	await assertReleased(scheduler);
}));

test("aborted pre-provider admission normalizes only empty unbilled synthetic errors", async () => fixture(async ({ ctx, emit }) => {
	const controller = new AbortController();
	ctx.signal = controller.signal;
	controller.abort();
	await assert.rejects(emit("context"), /abort/i);
	const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const cancelled = await emit("message_end", { message });
	assert.equal(cancelled.message.stopReason, "aborted");
	assert.deepEqual(cancelled.message.usage, message.usage);
	const billed = await emit("message_end", { message: { ...message, usage: { ...message.usage, input: 1, totalTokens: 1 } } });
	assert.equal(billed.message.stopReason, "error", "reported provider work must not be relabelled");
	const content = await emit("message_end", { message: { ...message, content: [{ type: "text", text: "partial" }] } });
	assert.equal(content.message.stopReason, "error");
}));

test("native guard admission covers success, failure, and abort without an early stream release", async (t) => {
	for (const ending of ["success", "error", "abort"]) await t.test(ending, () => fixture(async ({ scheduler, emit, setIdle }) => {
		const controller = new AbortController();
		await emit("session_before_tree", branch(controller.signal));
		assert.equal((await scheduler.snapshot()).requests.filter((request) => request.active).length, 1);
		if (ending === "success") await emit("session_tree");
		else {
			if (ending === "abort") controller.abort();
			await delay(140);
			assert.equal((await scheduler.snapshot()).requests.length, 1, "native stream still owns the request until its operation returns");
			// Supported SDKs have no session_tree_failed hook. Command-only tree
			// navigation restores idle in finally after errors/cancelled summaries.
			setIdle(true);
		}
		await assertReleased(scheduler);
	}));
});

test("native admission uses its own signal and compaction-failed releases promptly", async () => fixture(async ({ scheduler, ctx, emit }) => {
	ctx.signal = AbortSignal.abort(); // An overflow-recovery turn may already be aborted.
	await emit("session_before_compact", { signal: new AbortController().signal });
	assert.equal((await scheduler.snapshot()).requests.length, 1);
	await emit("session_compact_failed");
	await assertReleased(scheduler);
}));

test("cancelled native admission returns cancel rather than a swallowed extension error", async () => fixture(async ({ scheduler, emit, aborted }) => {
	const blocker = await scheduler.acquireRequest("other-request");
	try {
		const controller = new AbortController();
		const pending = emit("session_before_tree", branch(controller.signal));
		for (let i = 0; i < 50 && (await scheduler.snapshot()).requests.length < 2; i++) await delay(10);
		assert.equal((await scheduler.snapshot()).requests.length, 2);
		controller.abort();
		assert.deepEqual(await pending, { cancel: true });
		assert.equal(aborted(), true);
		assert.deepEqual((await scheduler.snapshot()).requests.map((request) => request.id), ["other-request"]);
	} finally { await blocker(); }
}));

test("a new admission waits for an in-flight maintenance release", async () => fixture(async ({ scheduler, emit, setIdle }) => {
	const prototype = Scheduler.prototype as any;
	const removeRequest = prototype.removeRequest;
	const gate = deferred();
	const entered = deferred();
	let block = true;
	prototype.removeRequest = async function (id: string, token?: string) {
		if (this.id === scheduler.id && id === "guard-owner-1" && block) {
			block = false;
			entered.resolve();
			await gate.promise;
		}
		return removeRequest.call(this, id, token);
	};
	try {
		await emit("session_before_tree", branch(new AbortController().signal));
		const oldToken = (await scheduler.snapshot()).requests[0].token;
		setIdle(true);
		await entered.promise;
		setIdle(false);
		let admitted = false;
		const next = emit("session_before_tree", branch(new AbortController().signal)).then(() => { admitted = true; });
		await delay(50);
		assert.equal(admitted, false, "the old permit must finish removal before another request can reuse its ID");
		gate.resolve();
		await next;
		const reservations = (await scheduler.snapshot()).requests;
		assert.equal(reservations.length, 1);
		assert.notEqual(reservations[0].token, oldToken);
		await emit("session_tree");
		await assertReleased(scheduler);
	} finally { gate.resolve(); prototype.removeRequest = removeRequest; }
}));

test("tree navigation without summarization needs no model reservation", async () => fixture(async ({ scheduler, emit }) => {
	await emit("session_before_tree", { signal: new AbortController().signal,
		preparation: { userWantsSummary: false, entriesToSummarize: [{}] } });
	assert.deepEqual((await scheduler.snapshot()).requests, []);
}));
