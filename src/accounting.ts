/** Usage provenance, durable recovery, and background attribution without changing model context usage. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { aggregateUsage, toModelUsage } from "./format.ts";
import type { ManagedTask } from "./tasks.ts";
import { emptyUsage, type UsageStats } from "./types.ts";

export interface AccountingMarker {
	taskIds: string[];
	usage: Usage;
}
export type AccountedMessage = AgentMessage & {
	subagentsExAccounting?: AccountingMarker;
	/** Usage already reported by managed descendants, including calls inside other tools. */
	subagentsExManagedUsage?: { treeId: string; usage: Usage };
	/** Stable identity shared by the child guard, RPC observer, and durable recovery. */
	subagentsExUsageEventId?: string;
	subagentsExBudgetAccounted?: boolean;
};

export interface SessionEntryView {
	type: string;
	id?: string;
	message?: unknown;
	customType?: string;
	data?: unknown;
	usage?: Usage;
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseSessionEntries(text: string, file: string): { entries: SessionEntryView[]; completeText: string } {
	const lines = text.split("\n");
	const entries: SessionEntryView[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		try {
			entries.push(JSON.parse(lines[i]));
		} catch (err) {
			if (i === lines.length - 1 && !text.endsWith("\n"))
				return { entries, completeText: text.slice(0, text.lastIndexOf("\n") + 1) };
			throw new Error(`Invalid session record at ${file}:${i + 1}`, { cause: err });
		}
	}
	return { entries, completeText: text };
}

/** Read complete durable records; only an incomplete final write is recoverable corruption. */
export function readSessionEntries(file: string): SessionEntryView[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return parseSessionEntries(text, file).entries;
}

/** Pi newline-repairs tails while loading. Remove only the incomplete suffix from the new copy. */
export function copySessionForResume(source: string, target: string): void {
	const { completeText } = parseSessionEntries(fs.readFileSync(source, "utf8"), source);
	fs.writeFileSync(target, completeText, { mode: 0o600 });
}

export function sessionEntryKey(entry: SessionEntryView): string {
	return entry.id ?? fingerprint(entry);
}

export function messageUsageKey(message: AgentMessage, namespace: string): string {
	// Guards assign UUIDs. The hash fallback supports older/third-party RPC peers;
	// namespace it per attempt so identical messages in different attempts still bill.
	const { subagentsExUsageEventId, subagentsExManagedUsage: _managed, subagentsExBudgetAccounted: _budget, ...original } = message as AccountedMessage;
	return `message:${namespace}:${subagentsExUsageEventId ?? fingerprint(original)}`;
}

export function nativeUsageKey(entry: SessionEntryView, namespace: string): string {
	return `entry:${namespace}:${sessionEntryKey(entry)}`;
}

export function nativeUsage(entry: SessionEntryView): Usage | undefined {
	return ["usage", "compaction", "branch_summary"].includes(entry.type) ? entry.usage : undefined;
}

export function usageStats(usage: Usage | undefined): UsageStats {
	return {
		...emptyUsage(),
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		cost: usage?.cost?.total ?? 0,
		contextTokens: usage?.totalTokens ?? 0,
	};
}

/** RPC unsubscribes before shutdown hooks; their final entries must be read from disk. */
export function readAccountingEntries(file: string): Array<{ id: string; data: AccountingMarker }> {
	return readSessionEntries(file)
		.filter((entry) => entry.type === "custom" && entry.customType === "subagents-ex-accounting")
		.map((entry) => ({ id: sessionEntryKey(entry), data: entry.data as AccountingMarker }));
}

type UsageResult = { details?: unknown; usage?: Usage };
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function runUsage(value: unknown): value is UsageStats {
	return object(value) && ["input", "output", "cacheRead", "cacheWrite", "cost", "turns", "contextTokens"]
		.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0);
}
function managedRuns(result: UsageResult, treeId: string): Map<string, UsageStats> {
	const managed = new Map<string, UsageStats>();
	// Details alone are not a charge: background collection returns run metadata
	// for free. Only call this for subagent executions that actually report usage.
	if (!result.usage || !object(result.details)) return managed;
	const runs: unknown = result.details.results;
	if (!Array.isArray(runs)) return managed;
	for (const [i, run] of runs.entries()) {
		if (!object(run) || run.treeId !== treeId || !runUsage(run.usage)) continue;
		if (run.id !== undefined && (typeof run.id !== "string" || !run.id)) continue;
		managed.set((run.id as string | undefined) ?? `legacy-${i}`, run.usage);
	}
	// Older direct results may omit per-run stats. Do not treat malformed stats
	// or unrelated/null metadata as managed, and distinguish separate legacy runs.
	if (!managed.size && runs.length && runs.every((run) => object(run) && run.treeId === treeId && run.usage === undefined &&
		(run.id === undefined || (typeof run.id === "string" && run.id.length > 0))))
		managed.set(`legacy:${fingerprint(runs)}`, usageStats(result.usage));
	return managed;
}

/** Track provenance through nested execution, independent of wrapper tool names or bounded nestedCalls metadata. */
export class ManagedUsageTracker {
	private roots = new Map<string, string>();
	private runs = new Map<string, Map<string, UsageStats>>();

	observe(event: { toolCallId: string; parentToolCallId?: string; toolName: string; result?: UsageResult }, treeId: string): void {
		const root = event.parentToolCallId
			? (this.roots.get(event.parentToolCallId) ?? event.parentToolCallId)
			: event.toolCallId;
		this.roots.set(event.toolCallId, root);
		if (!event.result || event.toolName !== "subagent") return;
		const found = managedRuns(event.result, treeId);
		if (!found.size) return;
		const collected = this.runs.get(root) ?? new Map<string, UsageStats>();
		for (const [id, usage] of found) collected.set(id, usage);
		this.runs.set(root, collected);
	}

	annotate(message: AgentMessage, treeId: string): AccountedMessage {
		if (message.role !== "toolResult") return message;
		const existing = (message as AccountedMessage).subagentsExManagedUsage;
		const collected = this.runs.get(message.toolCallId) ?? new Map<string, UsageStats>();
		if (message.toolName === "subagent")
			for (const [id, usage] of managedRuns(message, treeId)) collected.set(id, usage);
		this.runs.delete(message.toolCallId);
		for (const [id, root] of this.roots) if (root === message.toolCallId) this.roots.delete(id);
		if (existing?.treeId === treeId || !collected.size) return message;
		return {
			...message,
			subagentsExManagedUsage: { treeId, usage: toModelUsage(aggregateUsage([...collected.values()].map((usage) => ({ usage })))) },
		};
	}

	clear(): void {
		this.roots.clear();
		this.runs.clear();
	}
}

/** Only our descendants report directly to this tree; unrelated tools still bill here. */
export function isManagedSubagentUsage(message: AgentMessage, treeId: string): boolean {
	return message.role === "toolResult" && message.toolName === "subagent" && managedRuns(message, treeId).size > 0;
}

export function directUsage(message: AgentMessage, treeId: string): UsageStats {
	if (message.role !== "assistant" && message.role !== "toolResult") return emptyUsage();
	const accounted = message as AccountedMessage;
	const background = usageStats(accounted.subagentsExAccounting?.usage);
	const provenance = accounted.subagentsExManagedUsage;
	const managed = provenance?.treeId === treeId
		? usageStats(provenance.usage)
		: message.role === "toolResult" && message.toolName === "subagent"
			? aggregateUsage([...managedRuns(message, treeId).values()].map((usage) => ({ usage })))
			: emptyUsage();
	const direct = usageStats(message.usage);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens"] as const)
		direct[key] = Math.max(0, direct[key] - background[key] - managed[key]);
	return direct;
}

export class UsageLedger {
	private reserved = new Set<string>();
	claim(
		entries: ReadonlyArray<SessionEntryView>,
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
		entries: ReadonlyArray<SessionEntryView>,
		tasks: ManagedTask[],
	): AccountedMessage | undefined {
		// Assistant usage is evidence of the provider's actual context size. Never
		// add cumulative descendant tokens to it. Pi supports non-context tool usage;
		// leave idle completions pending until a tool result (or shutdown receipt).
		if (message.role !== "toolResult") return;
		const current = (message as AccountedMessage).subagentsExAccounting;
		const pending = this.claim(entries, tasks, current);
		if (!pending) return;
		const extra = pending.usage;
		const previous = message.usage;
		const usage = toModelUsage(emptyUsage());
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
