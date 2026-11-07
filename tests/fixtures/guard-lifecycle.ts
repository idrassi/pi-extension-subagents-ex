// Dedicated guard fixture: reproduce Pi 1.5.0's sequential async shutdown hooks,
// stdin-EOF shutdown, and removal of signal handlers before awaiting disposal.
// No model/provider requests are involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuard from "../../src/child-guard.ts";

type Handler = (event: any, ctx: any) => unknown;
function extension() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand() {},
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		async emit(type: string, event = {}) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, { sessionManager: { getEntries: () => [] } });
		},
	};
}

const [role, dir, scenario] = process.argv.slice(2);
const marker = (name: string, value: unknown = "ready") =>
	fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
const peer = fileURLToPath(new URL("./process-peer.mjs", import.meta.url));

if (role === "dispatcher") {
	const errorFd = fs.openSync(path.join(dir, "worker.stderr"), "w");
	try {
		const worker = spawn(process.execPath, [process.argv[1], "worker", dir, scenario], {
			detached: process.platform !== "win32",
			stdio: [scenario.startsWith("watchdog") ? "ignore" : "pipe", "ignore", errorFd],
			env: {
				...process.env,
				PI_SUBAGENTS_EX_PARENT_PID: String(process.pid),
				PI_SUBAGENTS_EX_TREE_ID: "orphan-fixture",
			},
		});
		worker.on("error", (err) => {
			marker("spawn-error", String(err));
			process.exit(1);
		});
		marker("worker-pid", String(worker.pid));
	} finally {
		fs.closeSync(errorFd);
	}
	setInterval(() => {}, 1000);
} else if (role === "worker") {
	const runtime = extension();
	const hang = () => {
		marker("shutdown-hang");
		return new Promise<void>(() => {});
	};
	if (scenario === "hang-before-guard") runtime.pi.on("session_shutdown", hang);
	if (scenario === "startup-hang") runtime.pi.on("session_start", () => {
		marker("startup-hang");
		return new Promise<void>(() => {});
	});
	childGuard(runtime.pi);
	if (scenario !== "watchdog-clean-exit" && scenario !== "hang-before-guard")
		runtime.pi.on("session_shutdown", hang);
	if (scenario === "startup-hang") {
		const descendant = spawn(process.execPath, [peer, "descendant", dir], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		await new Promise((resolve, reject) => {
			descendant.once("message", resolve);
			descendant.once("error", reject);
		});
		setInterval(() => {}, 1000);
		marker("ready");
		await runtime.emit("session_start", { reason: "startup" });
		throw new Error("Startup fixture must remain blocked before the guard's handler");
	}
	await runtime.emit("session_start", { reason: "startup" });
	const descendant = spawn(process.execPath, [peer, "descendant", dir], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	await new Promise((resolve, reject) => {
		descendant.once("message", resolve);
		descendant.once("error", reject);
	});
	const alive = setInterval(() => {}, 1000);
	let shuttingDown = false;
	const onTerm = () => void shutdown();
	async function shutdown() {
		if (shuttingDown) return;
		shuttingDown = true;
		process.off("SIGTERM", onTerm);
		marker("shutdown-started");
		await runtime.emit("session_shutdown", { reason: "quit" });
		clearInterval(alive);
		process.exit(0);
	}
	process.on("SIGTERM", onTerm);
	if (!scenario.startsWith("watchdog")) {
		process.stdin.on("end", () => void shutdown());
		process.stdin.resume();
	}
	marker("ready");
} else if (role === "lifecycle") {
	// Track even unref'ed timers: natural process exit alone would not catch an
	// interval leaked by a clean replacement or resources opened by the factory.
	const intervals = new Set<NodeJS.Timeout>();
	const timeouts = new Set<NodeJS.Timeout>();
	const nativeSetInterval = globalThis.setInterval;
	const nativeClearInterval = globalThis.clearInterval;
	const nativeSetTimeout = globalThis.setTimeout;
	const nativeClearTimeout = globalThis.clearTimeout;
	globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
		const timer = nativeSetInterval(...args);
		intervals.add(timer);
		return timer;
	}) as typeof setInterval;
	globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
		intervals.delete(timer);
		nativeClearInterval(timer);
	}) as typeof clearInterval;
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		const timer = nativeSetTimeout(...args);
		timeouts.add(timer);
		return timer;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer: NodeJS.Timeout) => {
		timeouts.delete(timer);
		nativeClearTimeout(timer);
	}) as typeof clearTimeout;
	const originalExitListeners = process.listenerCount("exit");
	for (const reason of ["reload", "new", "quit"]) {
		const runtime = extension();
		childGuard(runtime.pi);
		assert.equal(intervals.size, 1, "factory must protect even a blocked startup handler");
		assert.equal(timeouts.size, 0, "replacement factory must retire the outgoing deadline");
		await runtime.emit("session_start", { reason: "startup" });
		assert.equal(intervals.size, 1);
		assert.equal(timeouts.size, 0, "successor must cancel the outgoing deadline");
		assert.equal(process.listenerCount("exit"), originalExitListeners + 1);
		await runtime.emit("session_shutdown", { reason });
		assert.equal(intervals.size, 0, "shutdown must retire the polling interval");
		assert.equal(timeouts.size, 1, "shutdown must retain a hard deadline");
	}
	process.once("exit", () => {
		marker("lifecycle-result.json", { intervals: intervals.size, timeouts: timeouts.size });
	});
} else {
	throw new Error(`Unknown fixture role: ${role}`);
}
