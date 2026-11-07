/** Explicitly loaded in every RPC child, even when ordinary extensions are disabled. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Scheduler } from "./scheduler.ts";
import { isProcessAlive } from "./files.ts";
import { randomUUID } from "node:crypto";
import {
	ManagedUsageTracker,
	directUsage,
	messageUsageKey,
	nativeUsage,
	nativeUsageKey,
	readSessionEntries,
	sessionEntryKey,
	usageStats,
	type AccountedMessage,
} from "./accounting.ts";

export default function childGuard(pi: ExtensionAPI) {
	if (!process.env.PI_SUBAGENTS_EX_TREE_ID) return;
	const scheduler = new Scheduler();
	pi.registerCommand("subagents-ex-guard", {
		description: "Internal subagent budget guard v1",
		handler: async () => {},
	});
	const maxTurns = Number(process.env.PI_SUBAGENTS_EX_RUN_TURNS ?? Infinity);
	const maxCost = Number(process.env.PI_SUBAGENTS_EX_RUN_COST ?? Infinity);
	let turns = 0;
	let cost = 0;
	const namespace = process.env.PI_SUBAGENTS_EX_TASK_NAMESPACE ?? "legacy";
	let requestRelease: (() => Promise<void>) | undefined;
	let requestAdmission: Promise<void> | undefined;
	let requestReleasing: Promise<void> | undefined;
	let admissionAborted = false;
	let maintenanceTimer: NodeJS.Timeout | undefined;
	const releaseRequest = async () => {
		if (maintenanceTimer) clearInterval(maintenanceTimer);
		maintenanceTimer = undefined;
		if (requestReleasing) return requestReleasing;
		const release = requestRelease;
		requestRelease = undefined;
		if (release) {
			requestReleasing = Promise.resolve().then(release).finally(() => { requestReleasing = undefined; });
			return requestReleasing;
		}
	};
	const acquireRequest = async (_event: unknown, ctx: ExtensionContext, signal = ctx.signal) => {
		// A filesystem-lock retry is not FIFO. Never reuse the old reservation
		// while an asynchronous timer/terminal hook is still removing its token.
		await requestReleasing;
		if (requestRelease) return;
		if (requestAdmission) return requestAdmission;
		requestAdmission = (async () => {
			admissionAborted = false;
			try {
				requestRelease = await scheduler.acquireRequest(namespace, signal, (waiting) => {
					pi.appendEntry("subagents-ex-request-wait", { waiting });
				});
			} catch (err) {
				admissionAborted = signal?.aborted === true;
				pi.appendEntry("subagents-ex-limit", { status: "budget", reason: `Request admission failed: ${String(err)}` });
				ctx.abort();
				throw err;
			} finally { requestAdmission = undefined; }
		})();
		await requestAdmission;
	};
	// Ordinary requests keep their reservation through stream consumption, not
	// merely until response headers. Native summarizers bypass both these hooks.
	pi.on("context", acquireRequest);
	pi.on("before_provider_request", acquireRequest);
	const acquireMaintenance = async (event: { signal: AbortSignal }, ctx: ExtensionContext) => {
		try {
			await acquireRequest(event, ctx, event.signal);
			if (event.signal.aborted) { await releaseRequest(); return { cancel: true as const }; }
			// Branch navigation has no failure/end hook on supported SDKs. It is a
			// command-only idle operation: isIdle becomes true after its finally,
			// including error, abort, or a later extension cancelling the hook.
			// Poll only while native maintenance owns a reservation; never release
			// on the abort signal before the provider stream has actually stopped.
			if (maintenanceTimer) clearInterval(maintenanceTimer);
			maintenanceTimer = setInterval(() => {
				if (ctx.isIdle()) void releaseRequest().catch((err) => {
					pi.appendEntry("subagents-ex-limit", { status: "budget", reason: `Request release failed: ${String(err)}` });
					ctx.abort();
				});
			}, 100);
			maintenanceTimer.unref();
		} catch {
			// Session-before event errors are otherwise logged and ignored by pi.
			// Explicit cancellation must prevent an unadmitted native request.
			return { cancel: true as const };
		}
	};
	pi.on("session_before_compact", acquireMaintenance);
	pi.on("session_before_tree", async (event, ctx) => {
		if (event.preparation.userWantsSummary && event.preparation.entriesToSummarize.length)
			return acquireMaintenance(event, ctx);
	});
	pi.on("session_compact_failed", releaseRequest);
	// Idle cache warming has no assistant completion boundary to release a slot.
	pi.on("cache_warming_decision", () => ({ action: "stop" as const }));
	const provenance = new ManagedUsageTracker();
	const seenNative = new Set<string>();
	const sessionFile = process.env.PI_SUBAGENTS_EX_SESSION_FILE;
	// Read before session_start: another startup hook can already create new usage.
	if (sessionFile)
		for (const entry of readSessionEntries(sessionFile)) if (nativeUsage(entry)) seenNative.add(sessionEntryKey(entry));
	let nativeAccounting = Promise.resolve();
	// Scheduler receipts deduplicate debits, but overlapping hooks must also
	// serialize the local cost/seen update to avoid exhausting a run budget twice.
	const accountSessionUsage = (ctx: ExtensionContext) => (nativeAccounting = nativeAccounting.then(async () => {
		for (const entry of ctx.sessionManager.getEntries()) {
			const usage = nativeUsage(entry);
			if (!usage || seenNative.has(sessionEntryKey(entry))) continue;
			await scheduler.addUsage(process.env.PI_SUBAGENTS_EX_LEASE_ID!, usageStats(usage), nativeUsageKey(entry, namespace));
			seenNative.add(sessionEntryKey(entry));
			cost += usage.cost?.total ?? 0;
		}
	}));
	pi.on("session_start", (_event, ctx) => {
		// A copied continuation contains historical native charges, not new work.
		if (!sessionFile)
			for (const entry of ctx.sessionManager.getEntries()) if (nativeUsage(entry)) seenNative.add(sessionEntryKey(entry));
	});
	pi.on("tool_execution_start", (event) => provenance.observe(event, scheduler.id));
	pi.on("tool_execution_end", (event) => provenance.observe(event, scheduler.id));
	pi.on("agent_end", async () => { provenance.clear(); await releaseRequest(); });
	const accountNative = async (_event: unknown, ctx: ExtensionContext) => {
		try {
			await accountSessionUsage(ctx);
		} catch (err) {
			pi.appendEntry("subagents-ex-limit", { status: "budget", reason: `Budget accounting failed: ${String(err)}` });
			ctx.abort();
		} finally {
			await releaseRequest();
		}
	};
	pi.on("session_compact", accountNative);
	pi.on("session_tree", accountNative);
	// RPC workers own detached groups. A graceful shutdown can hang in another
	// extension, so replace parent polling with a hard deadline rather than simply
	// disabling protection when session_shutdown starts.
	const parentPid = Number(process.env.PI_SUBAGENTS_EX_PARENT_PID);
	const lifecycleKey = Symbol.for("pi-subagents-ex.orphan-guard");
	const owner = process as typeof process & { [lifecycleKey]?: () => void };
	let watchdog: NodeJS.Timeout | undefined;
	let hardDeadline: NodeJS.Timeout | undefined;
	let orphaned = false;
	const keepDeadlineAlive = () => {};
	const parentGone = () => process.ppid !== parentPid || !isProcessAlive(parentPid);
	const cleanup = () => {
		if (watchdog) clearInterval(watchdog);
		if (hardDeadline) clearTimeout(hardDeadline);
		watchdog = hardDeadline = undefined;
		process.off("exit", onExit);
		process.off("SIGTERM", keepDeadlineAlive);
		if (owner[lifecycleKey] === cleanup) delete owner[lifecycleKey];
	};
	const terminate = () => {
		cleanup();
		try {
			if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
			else process.kill(process.pid, "SIGKILL");
		} catch {
			// Direct/Windows launches need not own a POSIX process group.
			process.kill(process.pid, "SIGKILL");
		}
	};
	const onExit = () => {
		// An orphan may exit gracefully before its deadline. Kill remaining group
		// members here; a timer inside an exited leader cannot protect them.
		if (orphaned || parentGone()) terminate();
		else cleanup();
	};
	const armDeadline = () => {
		if (hardDeadline) return;
		hardDeadline = setTimeout(terminate, 5000);
		hardDeadline.unref();
	};
	const startWatchdog = () => {
		if (!Number.isInteger(parentPid) || parentPid <= 0) return;
		// Replacement runtimes get a new guard instance. Retire the outgoing
		// instance's deadline/listener without leaving intervals across reload/new.
		owner[lifecycleKey]?.();
		owner[lifecycleKey] = cleanup;
		process.once("exit", onExit);
		watchdog = setInterval(() => {
			if (!parentGone()) return;
			orphaned = true;
			if (watchdog) clearInterval(watchdog);
			watchdog = undefined;
			armDeadline();
			// Pi removes signal handlers before awaiting shutdown hooks. Keep a
			// handler installed so default SIGTERM/signal-exit cannot kill this
			// leader (and its deadline) without cleaning the rest of the group.
			process.on("SIGTERM", keepDeadlineAlive);
			if (process.platform === "win32") process.emit("SIGTERM", "SIGTERM");
			else process.kill(process.pid, "SIGTERM");
		}, 1000);
		watchdog.unref();
	};
	// Earlier startup hooks can hang before our session_start handler runs.
	// Protect the process immediately; the singleton also bounds factory reloads.
	startWatchdog();
	pi.on("session_start", startWatchdog);
	pi.on("session_shutdown", () => {
		if (owner[lifecycleKey] !== cleanup) return;
		if (watchdog) clearInterval(watchdog);
		watchdog = undefined;
		armDeadline(); // Cleared on process exit or the replacement session_start.
	});
	pi.on("session_shutdown", releaseRequest);
	pi.on("turn_start", async (_event, ctx) => {
		try {
			await accountSessionUsage(ctx);
			if (++turns > maxTurns) throw new Error(`Run turn budget reached (${maxTurns})`);
			if (cost >= maxCost) throw new Error(`Run cost budget reached ($${maxCost})`);
			await scheduler.beginTurn();
		} catch (err) {
			pi.appendEntry("subagents-ex-limit", { status: turns > maxTurns ? "max-turns" : "budget", reason: String(err) });
			ctx.abort();
		}
	});
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant" && msg.role !== "toolResult") return;
		try {
			if (msg.role === "assistant") await releaseRequest();
			await accountSessionUsage(ctx);
			const annotated: AccountedMessage = {
				...provenance.annotate(msg, scheduler.id),
				subagentsExUsageEventId: randomUUID(),
			};
			// Pi can label an aborted before-provider hook as an empty "error"
			// assistant. No request ran: preserve cancellation semantics so recovery
			// does not count a phantom turn. Never relabel content or reported usage.
			if (admissionAborted && annotated.role === "assistant" && annotated.stopReason === "error" && !annotated.content.length &&
				[annotated.usage.input, annotated.usage.output, annotated.usage.cacheRead, annotated.usage.cacheWrite,
					annotated.usage.totalTokens, annotated.usage.cost.total].every((value) => value === 0))
				annotated.stopReason = "aborted";
			await scheduler.addUsage(
				process.env.PI_SUBAGENTS_EX_LEASE_ID!,
				directUsage(annotated, scheduler.id),
				messageUsageKey(annotated, namespace),
			);
			cost += msg.usage?.cost.total ?? 0;
			return { message: { ...annotated, subagentsExBudgetAccounted: true } };
		} catch (err) {
			pi.appendEntry("subagents-ex-limit", { status: "budget", reason: `Budget accounting failed: ${String(err)}` });
			ctx.abort();
		}
	});
}
