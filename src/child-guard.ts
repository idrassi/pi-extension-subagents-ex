/** Explicitly loaded in every RPC child, even when ordinary extensions are disabled. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Scheduler } from "./scheduler.ts";
import { isProcessAlive } from "./files.ts";
import { directUsage } from "./accounting.ts";

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
	// RPC workers are detached for process-group cancellation; stop them if their dispatcher crashes.
	const parentPid = Number(process.env.PI_SUBAGENTS_EX_PARENT_PID);
	const watchdog =
		Number.isInteger(parentPid) && parentPid > 0
			? setInterval(() => {
					if (!isProcessAlive(parentPid)) process.kill(process.pid, "SIGTERM");
				}, 1000)
			: undefined;
	watchdog?.unref();
	pi.on("session_shutdown", () => {
		if (watchdog) clearInterval(watchdog);
	});
	pi.on("turn_start", async (_event, ctx) => {
		try {
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
			await scheduler.addUsage(process.env.PI_SUBAGENTS_EX_LEASE_ID!, directUsage(msg, scheduler.id));
			cost += msg.usage?.cost.total ?? 0;
			return { message: { ...msg, subagentsExBudgetAccounted: true } };
		} catch (err) {
			pi.appendEntry("subagents-ex-limit", { status: "budget", reason: `Budget accounting failed: ${String(err)}` });
			ctx.abort();
		}
	});
}
