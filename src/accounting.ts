/** Attribute settled background usage once, on the next persisted assistant/tool message. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { aggregateUsage, toModelUsage } from "./format.ts";
import type { ManagedTask } from "./tasks.ts";
import * as fs from "node:fs";
import { emptyUsage, type UsageStats } from "./types.ts";

export interface AccountingMarker {
	taskIds: string[];
	usage: Usage;
}
export type AccountedMessage = AgentMessage & { subagentsExAccounting?: AccountingMarker };

/** RPC unsubscribes before shutdown hooks; their final entries must be read from disk. */
export function readAccountingEntries(file: string): Array<{ id: string; data: AccountingMarker }> {
	if (!fs.existsSync(file)) return [];
	const entries: Array<{ id: string; data: AccountingMarker }> = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes("subagents-ex-accounting")) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "custom" && entry.customType === "subagents-ex-accounting") entries.push(entry);
		} catch {
			/* a forced termination can leave the final line incomplete */
		}
	}
	return entries;
}

/** Only our descendants report directly to this tree; unrelated tools still bill here. */
export function isManagedSubagentUsage(message: AgentMessage, treeId: string): boolean {
	if (message.role !== "toolResult" || message.toolName !== "subagent") return false;
	const details = message.details as { results?: Array<{ treeId?: string }> } | undefined;
	return details?.results?.some((r) => r.treeId === treeId) ?? false;
}

export function directUsage(message: AgentMessage, treeId: string): UsageStats {
	const stats = emptyUsage();
	if ((message.role !== "assistant" && message.role !== "toolResult") || isManagedSubagentUsage(message, treeId))
		return stats;
	const marker = (message as AccountedMessage).subagentsExAccounting?.usage;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
		stats[key] = Math.max(0, (message.usage?.[key] ?? 0) - (marker?.[key] ?? 0));
	stats.cost = Math.max(0, (message.usage?.cost.total ?? 0) - (marker?.cost.total ?? 0));
	stats.contextTokens = Math.max(0, (message.usage?.totalTokens ?? 0) - (marker?.totalTokens ?? 0));
	return stats;
}

export class UsageLedger {
	private reserved = new Set<string>();
	claim(
		entries: ReadonlyArray<{ type: string; message?: unknown; customType?: string; data?: unknown }>,
		tasks: ManagedTask[],
		current?: AccountingMarker,
	): AccountingMarker | undefined {
		const seen = new Set(this.reserved);
		for (const entry of entries) {
			const marker =
				entry.customType === "subagents-ex-accounting"
					? (entry.data as AccountingMarker)
					: (entry.message as AccountedMessage | undefined)?.subagentsExAccounting;
			for (const id of marker?.taskIds ?? []) seen.add(id);
		}
		for (const id of current?.taskIds ?? []) seen.add(id);
		const pending = tasks.filter((t) => t.endedAt && !seen.has(t.id));
		if (!pending.length) return;
		for (const task of pending) this.reserved.add(task.id);
		return { taskIds: pending.map((t) => t.id), usage: toModelUsage(aggregateUsage(pending)) };
	}
	apply(
		message: AgentMessage,
		entries: ReadonlyArray<{ type: string; message?: unknown; customType?: string; data?: unknown }>,
		tasks: ManagedTask[],
	): AccountedMessage | undefined {
		if (message.role !== "assistant" && message.role !== "toolResult") return;
		const current = (message as AccountedMessage).subagentsExAccounting;
		const pending = this.claim(entries, tasks, current);
		if (!pending) return;
		const extra = pending.usage;
		const previous = message.usage;
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
			usage[key] = (previous?.[key] ?? 0) + extra[key];
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			usage.cost[key] = (previous?.cost[key] ?? 0) + extra.cost[key];
		const attributed = structuredClone(extra);
		if (current) {
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
				attributed[key] += current.usage[key];
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
				attributed.cost[key] += current.usage.cost[key];
		}
		return {
			...message,
			usage,
			subagentsExAccounting: { taskIds: [...(current?.taskIds ?? []), ...pending.taskIds], usage: attributed },
		};
	}
}
