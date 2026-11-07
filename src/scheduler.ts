/** A process-shared admission queue and budget ledger for one parent session. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { STATE_DIR } from "./store.ts";
import { isProcessAlive, readJson, withLock, writeJson } from "./files.ts";
import { numberControl } from "./validation.ts";
import { emptyUsage, type UsageStats } from "./types.ts";
import { aggregateUsage } from "./format.ts";

const DEFAULT_CAPS = { maxProcesses: 64, maxQueued: 256, maxRequests: 20 };

export interface TreeLimits {
	/** Executing workers, not model requests or parked parents. */
	concurrency: number;
	maxProcesses: number;
	/** New waiting admissions, shared by the worker and request queues. */
	maxQueued: number;
	maxRequests: number;
	maxRuns?: number;
	maxTurns?: number;
	maxCost?: number;
}
interface Lease {
	id: string;
	pid: number;
	parentId?: string;
	active: boolean;
	parked: number;
	/** Reserved only on execution admission, retained through parking and resuming. */
	processReserved: boolean;
	order: number;
}
interface RequestReservation {
	id: string;
	pid: number;
	leaseId?: string;
	active: boolean;
	order: number;
	/** Prevents an old release callback from releasing a later reservation of the same ID. */
	token: string;
}
export interface TreeState {
	id: string;
	limits: TreeLimits;
	runs: number;
	turns: number;
	cost: number;
	sequence: number;
	leases: Lease[];
	requests: RequestReservation[];
	usageByRun: Record<string, { parentId?: string; usage: UsageStats; usageEvents?: Record<string, true> }>;
}

export class BudgetError extends Error {}

/** One shared watcher per tree/process; bounded polling also covers missed events and dead holders. */
class Changes {
	version = 0;
	users = 0;
	private listeners = new Set<() => void>();
	private watcher?: fs.FSWatcher;
	constructor(file: string) {
		try {
			this.watcher = fs.watch(path.dirname(file), (_event, name) => {
				if (name === null || String(name) === path.basename(file)) this.notify();
			});
			this.watcher.on("error", () => this.close());
			this.watcher.unref();
		} catch {
			// Watching is an optimization, never a requirement for progress.
		}
	}
	notify(): void {
		this.version++;
		for (const listener of [...this.listeners]) listener();
	}
	wait(version: number, ms: number, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				this.listeners.delete(wake);
				signal?.removeEventListener("abort", abort);
			};
			const wake = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(signal!.reason);
			};
			this.listeners.add(wake);
			signal?.addEventListener("abort", abort, { once: true });
			// The subscription precedes the version/abort checks: no wakeup can be lost
			// between reading the ledger, registering a waiter, and going to sleep.
			if (signal?.aborted) abort();
			else if (this.version !== version) wake();
			else timer = setTimeout(wake, ms);
		});
	}
	close(): void {
		this.watcher?.close();
		this.watcher = undefined;
	}
}
const changes = new Map<string, Changes>();

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
			maxProcesses:
				limits?.maxProcesses ??
				numberControl(process.env.PI_SUBAGENTS_EX_MAX_PROCESSES, "PI_SUBAGENTS_EX_MAX_PROCESSES", 1, 256, true) ??
				DEFAULT_CAPS.maxProcesses,
			maxQueued:
				limits?.maxQueued ??
				numberControl(process.env.PI_SUBAGENTS_EX_MAX_QUEUED, "PI_SUBAGENTS_EX_MAX_QUEUED", 1, 10_000, true) ??
				DEFAULT_CAPS.maxQueued,
			maxRequests:
				limits?.maxRequests ??
				numberControl(process.env.PI_SUBAGENTS_EX_MAX_REQUESTS, "PI_SUBAGENTS_EX_MAX_REQUESTS", 1, 128, true) ??
				DEFAULT_CAPS.maxRequests,
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
		numberControl(this.limits.maxProcesses, "maxProcesses", 1, 256, true);
		numberControl(this.limits.maxQueued, "maxQueued", 1, 10_000, true);
		numberControl(this.limits.maxRequests, "maxRequests", 1, 128, true);
		numberControl(this.limits.maxRuns, "maxRuns", 1, 10_000, true);
		numberControl(this.limits.maxTurns, "maxTurns", 1, 100_000, true);
		numberControl(this.limits.maxCost, "maxCost", 0.000001, 1_000_000);
	}

	/** Atomic rename makes unlocked read-only snapshots safe; migrations/pruning are in-memory here. */
	private load(): { state: TreeState; changed: boolean } {
		const saved = readJson<TreeState>(this.file);
		const state: TreeState = saved ?? {
			id: this.id,
			limits: { ...this.limits },
			runs: 0,
			turns: 0,
			cost: 0,
			sequence: 0,
			leases: [],
			requests: [],
			usageByRun: {},
		};
		let changed = !saved;
		// Never backfill optional legacy budgets from today's constructor/environment.
		// Fixed new-cap defaults also give all observers the same view before migration is saved.
		for (const key of ["maxProcesses", "maxQueued", "maxRequests"] as const) {
			if (state.limits[key] === undefined) {
				state.limits[key] = DEFAULT_CAPS[key];
				changed = true;
			}
		}
		if (!state.usageByRun) {
			state.usageByRun = {};
			changed = true;
		}
		if (!state.requests) {
			state.requests = [];
			changed = true;
		}
		for (const lease of state.leases) {
			if (lease.processReserved === undefined) {
				// Old ledgers cannot distinguish a queued worker from an already-live
				// parent resuming execution. Conservatively reserve legacy holders;
				// newly queued leases always have an explicit false reservation.
				lease.processReserved = true;
				lease.parentId ??= state.usageByRun[lease.id]?.parentId;
				changed = true;
			}
		}
		const alive = new Map<number, boolean>();
		const isAlive = (pid: number) => {
			if (!alive.has(pid)) alive.set(pid, isProcessAlive(pid));
			return alive.get(pid)!;
		};
		const leases = state.leases.filter((l) => isAlive(l.pid));
		const owners = new Set(leases.filter((l) => l.processReserved).map((l) => l.id));
		const requests = state.requests.filter((r) => isAlive(r.pid) && (!r.leaseId || owners.has(r.leaseId)));
		changed ||= leases.length !== state.leases.length || requests.length !== state.requests.length;
		state.leases = leases;
		state.requests = requests;
		return { state, changed };
	}

	private async mutate<T>(fn: (state: TreeState) => { value: T; changed: boolean }): Promise<T> {
		return withLock(this.file, () => {
			const loaded = this.load();
			const result = fn(loaded.state);
			if (loaded.changed || result.changed) {
				writeJson(this.file, loaded.state);
				changes.get(this.file)?.notify();
			}
			return result.value;
		});
	}

	private exhausted(state: TreeState): string | undefined {
		if (state.limits.maxCost !== undefined && state.cost >= state.limits.maxCost)
			return `Agent tree cost budget reached ($${state.limits.maxCost})`;
		return undefined;
	}
	private queued(state: TreeState): number {
		return state.leases.filter((l) => !l.processReserved).length + state.requests.filter((r) => !r.active).length;
	}
	private checkQueue(state: TreeState): void {
		if (this.queued(state) >= state.limits.maxQueued)
			throw new BudgetError(`Agent tree waiting queue limit reached (${state.limits.maxQueued})`);
	}
	private processCount(state: TreeState): number {
		return state.leases.filter((l) => l.processReserved).length;
	}
	private checkNested(state: TreeState, lease: Lease): void {
		if (lease.parentId && !lease.processReserved && this.processCount(state) >= state.limits.maxProcesses)
			throw new BudgetError(
				`Agent tree live process limit reached (${state.limits.maxProcesses}); nested admission rejected to avoid a parked-parent deadlock`,
			);
	}
	private canExecute(state: TreeState, lease: Lease): boolean {
		if (lease.active || lease.parked > 0) return true;
		if (state.leases.filter((l) => l.active).length >= state.limits.concurrency) return false;
		const room = this.processCount(state) < state.limits.maxProcesses;
		// Resuming parents already own a process and must be able to bypass a new
		// admission blocked on the process cap. FIFO among eligible workers remains.
		const first = state.leases
			.filter((l) => !l.active && l.parked === 0 && (l.processReserved || room))
			.reduce<Lease | undefined>((first, l) => (!first || l.order < first.order ? l : first), undefined);
		return first?.id === lease.id;
	}
	private canRequest(state: TreeState, request: RequestReservation): boolean {
		if (request.active) return true;
		if (state.requests.filter((r) => r.active).length >= state.limits.maxRequests) return false;
		const first = state.requests
			.filter((r) => !r.active)
			.reduce<RequestReservation | undefined>((first, r) => (!first || r.order < first.order ? r : first), undefined);
		return first?.id === request.id;
	}

	/** Watch before checking; only take a write lock when a read says admission may progress. */
	private async waitUntil(
		check: (s: TreeState, commit: boolean) => { changed: boolean } | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		let notifier = changes.get(this.file);
		if (!notifier) changes.set(this.file, (notifier = new Changes(this.file)));
		notifier.users++;
		let backoff = 25;
		try {
			while (true) {
				signal?.throwIfAborted();
				const version = notifier.version;
				if (check(this.load().state, false) !== undefined) {
					const result = await this.mutate((s) => {
						signal?.throwIfAborted();
						const ready = check(s, true);
						return { value: ready !== undefined, changed: ready?.changed ?? false };
					});
					if (result) return;
				}
				await notifier.wait(version, backoff, signal);
				backoff = Math.min(backoff * 2, 500);
			}
		} finally {
			if (--notifier.users === 0) {
				notifier.close();
				changes.delete(this.file);
			}
		}
	}

	async acquire(id: string, signal?: AbortSignal): Promise<() => Promise<void>> {
		signal?.throwIfAborted();
		const acquired = await this.mutate((state) => {
			signal?.throwIfAborted();
			if (state.leases.some((l) => l.id === id)) throw new Error(`Duplicate scheduler lease: ${id}`);
			const reason = this.exhausted(state);
			if (reason) throw new BudgetError(reason);
			if (state.limits.maxRuns !== undefined && state.runs >= state.limits.maxRuns)
				throw new BudgetError(`Agent tree run budget reached (${state.limits.maxRuns})`);
			if (state.limits.maxTurns !== undefined && state.turns >= state.limits.maxTurns)
				throw new BudgetError(`Agent tree turn budget reached (${state.limits.maxTurns})`);
			const parentId = process.env.PI_SUBAGENTS_EX_LEASE_ID;
			const lease: Lease = { id, pid: process.pid, parentId, active: false, parked: 0, processReserved: false, order: state.sequence };
			this.checkNested(state, lease);
			state.leases.push(lease);
			const ready = this.canExecute(state, lease);
			// Do not debit a run or leave a usage owner for a rejected admission.
			if (!ready) {
				state.leases.pop();
				this.checkQueue(state);
				state.leases.push(lease);
			}
			lease.active = lease.processReserved = ready;
			state.sequence++;
			state.runs++;
			state.usageByRun[id] = { parentId, usage: emptyUsage() };
			return { value: ready, changed: true };
		});
		try {
			if (!acquired) await this.waitForSlot(id, signal);
			signal?.throwIfAborted();
		} catch (err) {
			await this.release(id);
			throw err;
		}
		return () => this.release(id);
	}

	private async waitForSlot(id: string, signal?: AbortSignal, resuming = false): Promise<void> {
		await this.waitUntil((state, commit) => {
			const reason = this.exhausted(state);
			if (reason && !resuming) throw new BudgetError(reason);
			const lease = state.leases.find((l) => l.id === id);
			if (!lease) throw new Error("Scheduler lease was lost");
			this.checkNested(state, lease);
			if (!this.canExecute(state, lease)) return undefined;
			const changed = !lease.active && lease.parked === 0;
			if (commit && changed) lease.active = lease.processReserved = true;
			return { changed: commit && changed };
		}, signal);
	}

	async release(id: string): Promise<void> {
		await this.mutate((s) => {
			const leases = s.leases.filter((l) => l.id !== id);
			const requests = s.requests.filter((r) => r.leaseId !== id && r.id !== id);
			const changed = leases.length !== s.leases.length || requests.length !== s.requests.length;
			s.leases = leases;
			s.requests = requests;
			return { value: undefined, changed };
		});
	}

	/**
	 * One reservation per logical request/attempt ID, including provider retries.
	 * Hold until assistant message_end (before tools), agent_end, or shutdown; this
	 * does not track streams automatically and is not a reference-counted permit.
	 * The environment lease (or a matching ID) owns it for lease-release cleanup;
	 * standalone IDs without either are process-scoped and require explicit release.
	 * onWait observes actual queueing/resumption outside the file lock, including
	 * cancellation/failure. Observer exceptions cannot take ownership of a permit.
	 */
	async acquireRequest(
		id: string,
		signal?: AbortSignal,
		onWait?: (waiting: boolean) => void,
	): Promise<() => Promise<void>> {
		signal?.throwIfAborted();
		const reservation = await this.mutate((state) => {
			signal?.throwIfAborted();
			const existing = state.requests.find((r) => r.id === id);
			if (existing) return { value: { token: existing.token, ready: existing.active }, changed: false };
			const reason = this.exhausted(state);
			if (reason) throw new BudgetError(reason);
			const leaseId = process.env.PI_SUBAGENTS_EX_LEASE_ID ?? state.leases.find((l) => l.id === id)?.id;
			if (leaseId && !state.leases.some((l) => l.id === leaseId && l.processReserved))
				throw new Error("Scheduler lease was lost or has not reserved a process");
			const request: RequestReservation = { id, pid: process.pid, leaseId, active: false, order: state.sequence, token: randomUUID() };
			state.requests.push(request);
			const ready = this.canRequest(state, request);
			if (!ready) {
				state.requests.pop();
				this.checkQueue(state);
				state.requests.push(request);
			}
			request.active = ready;
			state.sequence++;
			return { value: { token: request.token, ready }, changed: true };
		});
		const notifyWait = (waiting: boolean) => {
			try {
				onWait?.(waiting);
			} catch {
				/* presentation observers do not own admission or cleanup */
			}
		};
		try {
			if (!reservation.ready) {
				notifyWait(true);
				await this.waitUntil((state, commit) => {
					const reason = this.exhausted(state);
					if (reason) throw new BudgetError(reason);
					const request = state.requests.find((r) => r.id === id && r.token === reservation.token);
					if (!request) throw new Error("Scheduler request reservation was lost");
					if (!this.canRequest(state, request)) return undefined;
					const changed = !request.active;
					if (commit) request.active = true;
					return { changed: commit && changed };
				}, signal);
			}
			signal?.throwIfAborted();
		} catch (err) {
			await this.removeRequest(id, reservation.token);
			throw err;
		} finally {
			if (!reservation.ready) notifyWait(false);
		}
		return () => this.removeRequest(id, reservation.token);
	}

	async releaseRequest(id: string): Promise<void> {
		await this.removeRequest(id);
	}
	private async removeRequest(id: string, token?: string): Promise<void> {
		await this.mutate((s) => {
			const requests = s.requests.filter((r) => r.id !== id || (token !== undefined && r.token !== token));
			const changed = requests.length !== s.requests.length;
			s.requests = requests;
			return { value: undefined, changed };
		});
	}

	/** Waiting parents yield execution slots, never their live-process reservations. */
	async whileWaiting<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const id = process.env.PI_SUBAGENTS_EX_LEASE_ID;
		if (!id) return fn();
		const parked = await this.mutate((s) => {
			const l = s.leases.find((l) => l.id === id);
			if (!l) return { value: false, changed: false };
			l.parked++;
			l.active = false;
			return { value: true, changed: true };
		});
		try {
			return await fn();
		} finally {
			if (parked) {
				await this.mutate((s) => {
					const l = s.leases.find((l) => l.id === id);
					if (l) {
						l.parked--;
						if (l.parked === 0) l.order = s.sequence++;
					}
					return { value: undefined, changed: !!l };
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
			return { value: undefined, changed: true };
		});
	}

	async addCost(cost: number): Promise<void> {
		if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid reported model cost");
		await this.mutate((s) => {
			s.cost += cost;
			return { value: undefined, changed: cost !== 0 };
		});
	}

	/** Direct usage is reported before RPC delivery, so parent cancellation cannot lose it. */
	async addUsage(id: string, usage: UsageStats, eventId?: string): Promise<void> {
		if (Object.values(usage).some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid reported usage");
		if (eventId !== undefined && (typeof eventId !== "string" || !eventId || eventId.length > 512))
			throw new Error("Invalid usage event id");
		await this.mutate((s) => {
			const entry = s.usageByRun[id];
			if (!entry) throw new Error(`Unknown usage owner: ${id}`);
			// The guard, RPC observer, and crash recovery can all observe one durable
			// charge. Commit its receipt and debit in the same locked transaction.
			if (eventId && Object.hasOwn(entry.usageEvents ?? {}, eventId)) return { value: undefined, changed: false };
			entry.usage = aggregateUsage([entry, { usage }]);
			s.cost += usage.cost;
			if (eventId)
				Object.defineProperty((entry.usageEvents ??= {}), eventId, { value: true, enumerable: true, configurable: true });
			return { value: undefined, changed: true };
		});
	}

	async subtreeUsage(id: string): Promise<UsageStats> {
		const s = this.load().state;
		return aggregateUsage(
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
		);
	}

	async budgetReason(): Promise<string | undefined> {
		return this.exhausted(this.load().state);
	}
	/** Reads do not initialize a tree; its first mutation fixes the configured limits. */
	async snapshot(): Promise<TreeState> {
		return this.load().state;
	}
}
