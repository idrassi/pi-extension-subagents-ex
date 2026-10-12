/** A process-shared admission queue and budget ledger for one parent session. */
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { STATE_DIR } from "./store.ts";
import { isProcessAlive, readJson, withLock, writeJson } from "./files.ts";
import { numberControl } from "./validation.ts";
import { emptyUsage, type UsageStats } from "./types.ts";
import { aggregateUsage } from "./format.ts";

export interface TreeLimits {
	concurrency: number;
	maxRuns?: number;
	maxTurns?: number;
	maxCost?: number;
}
interface Lease {
	id: string;
	pid: number;
	active: boolean;
	parked: number;
	order: number;
}
export interface TreeState {
	id: string;
	limits: TreeLimits;
	runs: number;
	turns: number;
	cost: number;
	sequence: number;
	leases: Lease[];
	usageByRun: Record<string, { parentId?: string; usage: UsageStats }>;
}

export class BudgetError extends Error {}

export class Scheduler {
	readonly id: string;
	readonly file: string;
	private limits: TreeLimits;
	constructor(id: string = process.env.PI_SUBAGENTS_EX_TREE_ID ?? randomUUID(), limits?: Partial<TreeLimits>) {
		if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid scheduler tree id");
		this.id = id;
		this.file = path.join(STATE_DIR, "trees", `${id}.json`);
		this.limits = {
			concurrency:
				limits?.concurrency ??
				numberControl(process.env.PI_SUBAGENTS_EX_CONCURRENCY, "PI_SUBAGENTS_EX_CONCURRENCY", 1, 32, true) ??
				20,
			maxRuns:
				limits?.maxRuns ??
				numberControl(process.env.PI_SUBAGENTS_EX_MAX_RUNS, "PI_SUBAGENTS_EX_MAX_RUNS", 1, 10_000, true),
			maxTurns:
				limits?.maxTurns ??
				numberControl(
					process.env.PI_SUBAGENTS_EX_MAX_TOTAL_TURNS,
					"PI_SUBAGENTS_EX_MAX_TOTAL_TURNS",
					1,
					100_000,
					true,
				),
			maxCost:
				limits?.maxCost ??
				numberControl(process.env.PI_SUBAGENTS_EX_MAX_COST, "PI_SUBAGENTS_EX_MAX_COST", 0.000001, 1_000_000),
		};
		numberControl(this.limits.concurrency, "concurrency", 1, 32, true);
		numberControl(this.limits.maxRuns, "maxRuns", 1, 10_000, true);
		numberControl(this.limits.maxTurns, "maxTurns", 1, 100_000, true);
		numberControl(this.limits.maxCost, "maxCost", 0.000001, 1_000_000);
	}

	private async mutate<T>(fn: (state: TreeState) => T): Promise<T> {
		return withLock(this.file, () => {
			const state = readJson<TreeState>(this.file) ?? {
				id: this.id,
				limits: this.limits,
				runs: 0,
				turns: 0,
				cost: 0,
				sequence: 0,
				leases: [],
				usageByRun: {},
			};
			state.usageByRun ??= {};
			state.leases = state.leases.filter((l) => isProcessAlive(l.pid));
			const result = fn(state);
			writeJson(this.file, state);
			return result;
		});
	}

	private exhausted(state: TreeState): string | undefined {
		if (state.limits.maxCost !== undefined && state.cost >= state.limits.maxCost)
			return `Agent tree cost budget reached ($${state.limits.maxCost})`;
		return undefined;
	}

	async acquire(id: string, signal?: AbortSignal): Promise<() => Promise<void>> {
		signal?.throwIfAborted();
		await this.mutate((state) => {
			if (state.leases.some((l) => l.id === id)) throw new Error(`Duplicate scheduler lease: ${id}`);
			const reason = this.exhausted(state);
			if (reason) throw new BudgetError(reason);
			if (state.limits.maxRuns !== undefined && state.runs >= state.limits.maxRuns)
				throw new BudgetError(`Agent tree run budget reached (${state.limits.maxRuns})`);
			if (state.limits.maxTurns !== undefined && state.turns >= state.limits.maxTurns)
				throw new BudgetError(`Agent tree turn budget reached (${state.limits.maxTurns})`);
			state.runs++;
			state.usageByRun[id] = { parentId: process.env.PI_SUBAGENTS_EX_LEASE_ID, usage: emptyUsage() };
			state.leases.push({ id, pid: process.pid, active: false, parked: 0, order: state.sequence++ });
		});
		try {
			await this.waitForSlot(id, signal);
		} catch (err) {
			await this.release(id);
			throw err;
		}
		return () => this.release(id);
	}

	private async waitForSlot(id: string, signal?: AbortSignal, resuming = false): Promise<void> {
		while (true) {
			signal?.throwIfAborted();
			const acquired = await this.mutate((state) => {
				const reason = this.exhausted(state);
				if (reason && !resuming) throw new BudgetError(reason);
				const lease = state.leases.find((l) => l.id === id);
				if (!lease) throw new Error("Scheduler lease was lost");
				if (lease.active || lease.parked > 0) return true;
				const first = state.leases.filter((l) => !l.active && l.parked === 0).sort((a, b) => a.order - b.order)[0];
				if (first?.id !== id || state.leases.filter((l) => l.active).length >= state.limits.concurrency) return false;
				lease.active = true;
				return true;
			});
			if (acquired) return;
			await delay(50, undefined, { signal });
		}
	}

	async release(id: string): Promise<void> {
		await this.mutate((s) => {
			s.leases = s.leases.filter((l) => l.id !== id);
		});
	}

	/** Waiting parents yield their execution slots to descendants, preventing nested pool deadlocks. */
	async whileWaiting<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const id = process.env.PI_SUBAGENTS_EX_LEASE_ID;
		if (!id) return fn();
		const parked = await this.mutate((s) => {
			const l = s.leases.find((l) => l.id === id);
			if (!l) return false;
			l.parked++;
			l.active = false;
			return true;
		});
		try {
			return await fn();
		} finally {
			if (parked) {
				await this.mutate((s) => {
					const l = s.leases.find((l) => l.id === id);
					if (l) {
						l.parked--;
						l.order = s.sequence++;
					}
				});
				// Preserve completed tool results at the ceiling; the guard stops the next turn.
				if (!signal?.aborted) await this.waitForSlot(id, signal, true);
			}
		}
	}

	async beginTurn(): Promise<void> {
		await this.mutate((s) => {
			const reason = this.exhausted(s);
			if (reason) throw new BudgetError(reason);
			if (s.limits.maxTurns !== undefined && s.turns >= s.limits.maxTurns)
				throw new BudgetError(`Agent tree turn budget reached (${s.limits.maxTurns})`);
			s.turns++;
		});
	}

	async addCost(cost: number): Promise<void> {
		if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid reported model cost");
		await this.mutate((s) => {
			s.cost += cost;
		});
	}

	/** Direct usage is reported before RPC delivery, so parent cancellation cannot lose it. */
	async addUsage(id: string, usage: UsageStats): Promise<void> {
		if (Object.values(usage).some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid reported usage");
		await this.mutate((s) => {
			const entry = s.usageByRun[id];
			if (!entry) throw new Error(`Unknown usage owner: ${id}`);
			entry.usage = aggregateUsage([entry, { usage }]);
			s.cost += usage.cost;
		});
	}

	async subtreeUsage(id: string): Promise<UsageStats> {
		return this.mutate((s) =>
			aggregateUsage(
				Object.entries(s.usageByRun)
					.filter(([runId]) => {
						const seen = new Set<string>();
						let ancestor: string | undefined = runId;
						while (ancestor && !seen.has(ancestor)) {
							if (ancestor === id) return true;
							seen.add(ancestor);
							ancestor = s.usageByRun[ancestor]?.parentId;
						}
						return false;
					})
					.map(([, entry]) => entry),
			),
		);
	}

	async budgetReason(): Promise<string | undefined> {
		return this.mutate((s) => this.exhausted(s));
	}
	async snapshot(): Promise<TreeState> {
		return this.mutate((s) => structuredClone(s));
	}
}
