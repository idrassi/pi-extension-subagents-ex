/** Subagents EX: validated plans, RPC workers, shared budgets, and durable results. */
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BUNDLED_PROMPTS_DIR, discoverAgents, type AgentScope } from "./agents.ts";
import { UsageLedger } from "./accounting.ts";
import { openDashboard } from "./dashboard.ts";
import { formatDuration, formatUsageStats } from "./format.ts";
import { buildPlan, type PlanInput } from "./plan.ts";
import { executePlan } from "./orchestrator.ts";
import { renderSubagentCall, renderSubagentResult, renderTaskListResult } from "./render.ts";
import { Runner } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import {
	claimWorktree,
	listRuns,
	listWorktreeRecords,
	loadRunById,
	unregisterWorktree,
	worktreeIsActive,
} from "./store.ts";
import { TaskManager, serializeTask, waitForTask } from "./tasks.ts";
import type { SubagentDetails } from "./types.ts";
import { MAX_CHAIN_STEPS, MAX_PARALLEL_TASKS, MAX_RETRIES, MAX_TIMEOUT_SECONDS, numberControl } from "./validation.ts";
import { removeWorktree } from "./worktree.ts";

const depth = Number.parseInt(process.env.PI_SUBAGENTS_EX_DEPTH ?? "0", 10) || 0;
const Controls = {
	model: Type.Optional(Type.String({ description: "Model override: provider/id" })),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
			description: "Thinking override; defaults to the agent setting or parent session, even when model is overridden",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			minimum: 0.001,
			maximum: MAX_TIMEOUT_SECONDS,
			description: "Optional total run deadline in seconds, including queueing and retries; unset by default",
		}),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 100_000,
			description: "Optional assistant turn allowance across attempts; unset by default",
		}),
	),
	retries: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_RETRIES })),
	maxCost: Type.Optional(
		Type.Number({
			minimum: 0.000001,
			maximum: 1_000_000,
			description: "Observed run cost ceiling in USD; in-flight requests can overshoot",
		}),
	),
};
const IsolationSchema = StringEnum(["none", "worktree"] as const, {
	description: "Dedicated checkout based on committed HEAD; a patch artifact is returned for integration",
});
const ItemProperties = {
	agent: Type.String(),
	task: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String()),
	...Controls,
};
const Item = Type.Object({ ...ItemProperties, isolation: Type.Optional(IsolationSchema) });
const Params = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String({ minLength: 1 })),
	cwd: Type.Optional(Type.String()),
	resume: Type.Optional(
		Type.String({
			description: "Saved run id to continue with task as a follow-up; retains its child session and checkout",
		}),
	),
	tasks: Type.Optional(Type.Array(Item, { minItems: 1, maxItems: MAX_PARALLEL_TASKS })),
	chain: Type.Optional(
		Type.Array(Type.Object(ItemProperties), {
			minItems: 1,
			maxItems: MAX_CHAIN_STEPS,
			description: "Sequential tasks with literal {previous} or {steps.N} references",
		}),
	),
	runInBackground: Type.Optional(Type.Boolean()),
	notify: Type.Optional(Type.Boolean()),
	isolation: Type.Optional(IsolationSchema),
	outputFormat: Type.Optional(StringEnum(["text", "json"] as const)),
	outputSchema: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "JSON Schema draft-07 for the child's final output; implies outputFormat json",
		}),
	),
	agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const)),
	...Controls,
});

type Policy = "off" | "balanced" | "aggressive";

export default function subagentsExtension(pi: ExtensionAPI) {
	if (depth >= 3) return;
	let policy: Policy =
		process.env.PI_SUBAGENTS_EX_POLICY === "off" || process.env.PI_SUBAGENTS_EX_POLICY === "aggressive"
			? process.env.PI_SUBAGENTS_EX_POLICY
			: "balanced";
	let tasks: TaskManager;
	let runner: Runner;
	let ledger: UsageLedger;
	let lastCtx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let closing = false;
	let widgetTimer: NodeJS.Timeout | undefined;
	const approvals = new Set<string>();

	const updateWidget = () => {
		if (closing || !lastCtx?.hasUI || !tasks) return;
		const active = tasks.list().filter((t) => !t.endedAt);
		lastCtx.ui.setWidget(
			"subagents-ex",
			active.length
				? active.map(
						(t) =>
							`${t.id.slice(0, 13)} · ${t.status} · ${t.label} · ${formatDuration(Date.now() - t.startedAt)} · $${t.usage.cost.toFixed(4)}`,
					)
				: undefined,
			{ placement: "belowEditor" },
		);
		if (active.length && !widgetTimer) {
			widgetTimer = setInterval(updateWidget, 1000);
			widgetTimer.unref();
		}
		if (!active.length && widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
	};
	const ensureSession = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		const id = ctx.sessionManager.getSessionId();
		if (sessionId === id) return;
		closing = false;
		tasks = new TaskManager(id);
		ledger = new UsageLedger();
		runner = new Runner({
			scheduler: new Scheduler(process.env.PI_SUBAGENTS_EX_TREE_ID ?? createHash("sha256").update(id).digest("hex")),
		});
		sessionId = id;
		tasks.onSettle((task) => {
			updateWidget();
			if (closing || !task.notify) return;
			const content = `[subagents-ex] ${task.id} (${task.label}) ${task.status}: ${task.summary}\nCollect with subagent_task_output. Saved run ids: ${task.result?.details.results.map((r) => r.id).join(", ") || "none"}.`;
			if (ctx.isIdle()) ctx.ui.notify(`${task.label}: ${task.status}`, task.status === "done" ? "info" : "warning");
			pi.sendMessage(
				{ customType: "subagents-ex", content, display: false },
				{ deliverAs: ctx.isIdle() ? "nextTurn" : "steer" },
			);
		});
	};

	pi.on("session_start", (_event, ctx) => ensureSession(ctx));
	pi.on("session_shutdown", async () => {
		closing = true;
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		await tasks?.shutdown();
		// Children can finish while their background tasks are still active. Their
		// parent RPC runner owns the final bill, including usage observed during shutdown.
		if (depth > 0 && lastCtx && tasks) {
			const pending = ledger.claim(lastCtx.sessionManager.getEntries(), tasks.list());
			if (pending) pi.appendEntry("subagents-ex-accounting", pending);
		}
	});
	pi.on("resources_discover", () => ({ promptPaths: [BUNDLED_PROMPTS_DIR] }));
	pi.on("message_end", (event, ctx) => {
		ensureSession(ctx);
		const message = ledger.apply(event.message, ctx.sessionManager.getEntries(), tasks.list());
		if (message) return { message };
	});
	pi.on("tool_result", (event) => {
		if (!event.toolName.startsWith("subagent")) return;
		const details = event.details as { status?: string; task?: { status?: string } } | undefined;
		const status = details?.status ?? details?.task?.status;
		if (status && ["error", "aborted", "killed", "interrupted"].includes(status)) return { isError: true };
	});
	pi.on("before_agent_start", (event, ctx) => {
		ensureSession(ctx);
		if (policy === "off") {
			delete event.systemPromptOptions.sections.subagents;
			return;
		}
		const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user");
		const emphasis =
			policy === "aggressive"
				? "Delegate independent investigations and specialist implementation/review/test work unless the user opts out."
				: "Delegate when a well-scoped specialist task or independent investigation benefits from its own context.";
		event.systemPromptOptions.sections.subagents = [
			"Subagents run in separate pi processes and share an execution budget.",
			emphasis,
			"Provide acceptance criteria and necessary context. Use parallel mode for independent tasks and chains for dependencies.",
			"Use worktree isolation for parallel coding. Review the returned patch and verification evidence before applying it.",
			"Background tasks can be steered with subagent_task_send. Collect their results before declaring their work complete.",
			"Resume a saved run using subagent({resume: runId, task: followUp}); costs are new work and share the session budget.",
			"Project agents require project trust or user approval; use agentScope both to select them.",
			"Available agents:",
			...discovery.agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`),
			...discovery.errors.map((e) => `Invalid agent definition: ${e}`),
		].join("\n");
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Execute specialist agents as a single task, parallel tasks, or a sequential chain. Supports background work, worktrees with patch artifacts, budgets, validated JSON, and resuming a saved run. Returns run ids, output, artifacts, and usage.",
		promptSnippet: "Run specialist agents (single, parallel, chain, background, resume)",
		parameters: Params,
		prepareArguments(args) {
			if (args && typeof args === "object") {
				const value = args as Record<string, unknown>;
				if (typeof value.background === "boolean" && value.runInBackground === undefined)
					return { ...value, runInBackground: value.background } as any;
			}
			return args as any;
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			ensureSession(ctx);
			let plan;
			try {
				const scope: AgentScope = params.agentScope ?? "user";
				const discovery = discoverAgents(ctx.cwd, scope);
				const resumed = params.resume ? (loadRunById(params.resume) ?? undefined) : undefined;
				plan = buildPlan(
					params as PlanInput,
					discovery.agents,
					{
						cwd: ctx.cwd,
						model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						thinkingLevel: ctx.thinkingLevel,
						depth,
					},
					discovery.projectAgentsDir,
					resumed,
				);
				const unapproved = plan.steps
					.map((s) => s.agent)
					.filter(
						(agent) =>
							agent.source === "project" &&
							!ctx.isProjectTrusted() &&
							!approvals.has(createHash("sha256").update(JSON.stringify(agent)).digest("hex")),
					);
				if (unapproved.length) {
					if (!ctx.hasUI)
						throw new Error(
							"Project agents require user approval or project trust; untrusted headless execution is disabled",
						);
					if (
						!(await ctx.ui.confirm(
							"Run project-local agents?",
							`${unapproved.map((a) => `${a.name}: ${a.filePath}`).join("\n")}\nThese definitions are controlled by the repository.`,
						))
					)
						throw new Error("Project agents were not approved");
					for (const agent of unapproved)
						approvals.add(createHash("sha256").update(JSON.stringify(agent)).digest("hex"));
				}
				for (const step of plan.steps)
					if (!fs.statSync(step.overrides.cwd!).isDirectory())
						throw new Error(`Invalid working directory: ${step.overrides.cwd}`);
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					details: {
						mode: "single",
						agentScope: params.agentScope ?? "user",
						projectAgentsDir: null,
						results: [],
						status: "error",
						errorMessage: String(err),
					} satisfies SubagentDetails,
				};
			}
			const executionPlan = plan;
			if (params.runInBackground) {
				const task = tasks.start(
					plan.mode,
					plan.steps.map((s) => s.agent.name).join(plan.mode === "chain" ? " → " : ", "),
					params.notify ?? true,
					(taskSignal, progress) =>
						executePlan(executionPlan, runner, taskSignal, (result) => {
							progress(result);
							updateWidget();
						}),
				);
				updateWidget();
				return {
					content: [
						{
							type: "text",
							text: `Queued ${task.id} (${task.label}). Collect with subagent_task_output; steer with subagent_task_send.`,
						},
					],
					details: {
						mode: "background",
						agentScope: plan.agentScope,
						projectAgentsDir: plan.projectAgentsDir,
						results: [],
						status: "running",
						taskId: task.id,
						notify: task.notify,
					} satisfies SubagentDetails,
				};
			}
			return runner.scheduler.whileWaiting(() => executePlan(executionPlan, runner, signal, onUpdate), signal);
		},
		renderCall: (args, theme) => renderSubagentCall(args, theme),
		renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
	});

	pi.registerTool({
		name: "subagent_task_list",
		label: "Subagent Task List",
		description:
			"List this session's background tasks, including recovered snapshots, current progress, usage, and run ids.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			ensureSession(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							tasks
								.list()
								.map(
									(t) =>
										`${t.id} ${t.status} — ${t.label} — ${formatUsageStats(t.usage)} — ${t.summary}\nRuns: ${t.result?.details.results.map((r) => `${r.id} (${r.status})`).join(", ") || "queued"}`,
								)
								.join("\n") || "No background tasks in this session.",
					},
				],
				details: { tasks: tasks.list().map(serializeTask) },
			};
		},
		renderResult: renderTaskListResult,
	});
	pi.registerTool({
		name: "subagent_task_output",
		label: "Subagent Task Output",
		description:
			"Read a background result without charging its usage again. Optionally wait for completion; waiting can be cancelled without killing the task.",
		parameters: Type.Object({
			id: Type.String(),
			wait: Type.Optional(Type.Boolean()),
			timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.001, maximum: MAX_TIMEOUT_SECONDS })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			ensureSession(ctx);
			const task = tasks.get(params.id);
			if (!task) throw new Error(`Unknown task ${params.id}`);
			const timeout = numberControl(params.timeoutSeconds ?? 600, "timeoutSeconds", 0.001, MAX_TIMEOUT_SECONDS)!;
			if (!task.endedAt && (params.wait ?? true))
				await runner.scheduler.whileWaiting(() => waitForTask(task, timeout, signal), signal);
			const text = task.result?.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return {
				content: [
					{
						type: "text",
						text: `${task.id} ${task.status} — ${task.label}\n${formatUsageStats(task.usage)}\n${task.endedAt ? text || task.errorMessage || task.summary : task.summary}`,
					},
				],
				details: { task: serializeTask(task), results: task.result?.details.results },
			};
		},
		renderResult: renderTaskListResult,
	});
	pi.registerTool({
		name: "subagent_task_send",
		label: "Steer Subagent",
		description:
			"Send a follow-up instruction to an active background worker. For parallel tasks specify its runId, available from subagent_task_list. Use subagent resume after a worker settles.",
		parameters: Type.Object({
			id: Type.String(),
			message: Type.String({ minLength: 1 }),
			runId: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			ensureSession(ctx);
			const task = tasks.get(params.id);
			if (!task || task.endedAt) throw new Error("Task is not running; resume its saved run instead");
			const ids =
				task.result?.details.results.map((r) => r.id).filter((id) => runner.activeRunIds().includes(id)) ?? [];
			const target = params.runId ?? (ids.length === 1 ? ids[0] : undefined);
			if (!target || !ids.includes(target))
				throw new Error(`Select one active runId: ${ids.join(", ") || "none accepting steering yet"}`);
			await runner.steer(target, params.message);
			return { content: [{ type: "text", text: `Instruction queued for ${target}.` }], details: { runId: target } };
		},
	});
	pi.registerTool({
		name: "subagent_task_kill",
		label: "Kill Subagent",
		description: "Cancel a queued or running background task and its current workers.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			ensureSession(ctx);
			return {
				content: [
					{
						type: "text",
						text: tasks.kill(params.id)
							? `Cancellation requested for ${params.id}.`
							: `${params.id} is unknown or already settled.`,
					},
				],
				details: {},
			};
		},
		renderResult: renderTaskListResult,
	});

	pi.registerCommand("agents-policy", {
		description: "Set delegation guidance: off | balanced | aggressive",
		getArgumentCompletions: (prefix) =>
			["off", "balanced", "aggressive"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			ensureSession(ctx);
			const next = args.trim();
			if (next && !["off", "balanced", "aggressive"].includes(next))
				throw new Error("Expected off, balanced, or aggressive");
			if (next) policy = next as Policy;
			ctx.ui.notify(`Subagent delegation policy: ${policy}`, "info");
		},
	});
	pi.registerCommand("agents", {
		description: "Open task dashboard and run history",
		handler: async (_args, ctx) => {
			ensureSession(ctx);
			if (ctx.mode === "tui") await openDashboard(ctx, tasks, () => listRuns(30));
			else
				ctx.ui.notify(
					tasks
						.list()
						.map((t) => `${t.id} ${t.status}: ${t.label}`)
						.join("\n") || "No background tasks.",
					"info",
				);
		},
	});
	pi.registerCommand("agents-budget", {
		description: "Show shared agent-tree concurrency, turn, run, and cost budgets",
		handler: async (_args, ctx) => {
			ensureSession(ctx);
			const state = await runner.scheduler.snapshot();
			ctx.ui.notify(
				`Agent tree: ${state.leases.filter((l) => l.active).length}/${state.limits.concurrency} active, ${state.runs}/${state.limits.maxRuns ?? "unlimited"} runs, ${state.turns}/${state.limits.maxTurns ?? "unlimited"} turns, $${state.cost.toFixed(4)}${state.limits.maxCost ? `/$${state.limits.maxCost}` : ""}`,
				"info",
			);
		},
	});
	pi.registerCommand("agents-clean-worktrees", {
		description: "Remove inactive subagent worktrees and branches after confirmation",
		handler: async (_args, ctx) => {
			ensureSession(ctx);
			const records = listWorktreeRecords();
			const available = records.filter((r) => !worktreeIsActive(r));
			if (!available.length) {
				ctx.ui.notify("No inactive subagent worktrees to clean.", "info");
				return;
			}
			if (
				!ctx.hasUI ||
				!(await ctx.ui.confirm(
					"Remove inactive worktrees?",
					`Unmerged changes and branches will be removed. Exported patches remain. ${records.length - available.length} active worktrees skipped.\n${available.map((r) => `${r.branch}: ${r.path}`).join("\n")}`,
				))
			)
				return;
			const messages: string[] = [];
			for (const record of available) {
				let release: (() => Promise<void>) | undefined;
				try {
					release = await claimWorktree(record, `cleanup-${randomUUID()}`);
					const result = await removeWorktree(record, true);
					if (!result.ok) throw new Error(result.error);
					await release();
					release = undefined;
					await unregisterWorktree(record.path);
					messages.push(`Removed ${record.branch}`);
				} catch (err) {
					messages.push(`${record.branch}: ${String(err)}`);
				} finally {
					await release?.();
				}
			}
			ctx.ui.notify(messages.join("\n"), "info");
		},
	});
}
