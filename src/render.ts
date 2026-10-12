/**
 * TUI renderers for the subagent tool (call header + result views),
 * adapted from pi's subagent example and extended with statuses, budgets,
 * attempts, worktrees and background task cards.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	type DisplayItem,
	aggregateUsage,
	formatDuration,
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
} from "./format.ts";
import type { RunRecord, RunStatus, SubagentDetails } from "./types.ts";
import { isRunFailed } from "./types.ts";

const COLLAPSED_ITEM_COUNT = 10;

interface Theme {
	fg(color: any, text: string): string;
	bold(text: string): string;
}

function statusIcon(status: RunStatus, theme: Theme): string {
	switch (status) {
		case "ok":
			return theme.fg("success", "✓");
		case "running":
		case "queued":
			return theme.fg("warning", "⏳");
		case "timeout":
		case "max-turns":
			return theme.fg("error", "⏱");
		case "aborted":
			return theme.fg("warning", "⚠");
		default:
			return theme.fg("error", "✗");
	}
}

function recordHeaderLine(r: RunRecord, theme: Theme): string {
	const icon = statusIcon(r.status, theme);
	let line = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (r.status !== "ok" && r.status !== "running") line += ` ${theme.fg("error", `[${r.status}]`)}`;
	if (r.attempts > 1) line += theme.fg("dim", ` attempt ${r.attempts}`);
	return line;
}

function recordMetaLines(r: RunRecord, theme: Theme): string[] {
	const lines: string[] = [];
	if (r.errorMessage && r.status !== "ok") lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
	if (r.worktree) {
		lines.push(
			theme.fg("muted", "worktree: ") +
				theme.fg("accent", r.worktree.path) +
				theme.fg("dim", ` (branch ${r.worktree.branch})`),
		);
	}
	return lines;
}

function renderDisplayItems(items: DisplayItem[], expanded: boolean, theme: Theme, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function usageLine(records: RunRecord[], prefix: string | undefined, theme: Theme): string {
	const stats = records.length === 1 ? records[0].usage : aggregateUsage(records);
	const model = records.length === 1 ? records[0].model : undefined;
	const str = formatUsageStats(stats, model);
	return str ? theme.fg("dim", `${prefix ?? ""}${str}`) : "";
}

// ---------------------------------------------------------------------------
// renderCall
// ---------------------------------------------------------------------------

export function renderSubagentCall(args: any, theme: Theme): Text {
	const scope = args.agentScope ?? "user";
	const bg = args.runInBackground ? theme.fg("warning", " [background]") : "";
	const json = args.outputFormat === "json" ? theme.fg("dim", " [json]") : "";

	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`) +
			bg +
			json;
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			const cleanTask = String(step.task)
				.replace(/\{previous\}|\{steps\.\d+\}/g, "")
				.trim();
			const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}

	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`) +
			bg +
			json;
		for (const t of args.tasks.slice(0, 3)) {
			const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
			const iso = t.isolation === "worktree" ? theme.fg("dim", " ⌧") : "";
			text += `\n  ${theme.fg("accent", t.agent)}${iso}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}

	const agentName = args.agent || "...";
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	const iso = args.isolation === "worktree" ? theme.fg("dim", " ⌧ worktree") : "";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`) +
		bg +
		json +
		iso;
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

export function renderSubagentResult(result: any, options: { expanded: boolean }, theme: Theme): any {
	const details = result.details as SubagentDetails | undefined;
	const expanded = options.expanded;

	if (!details || (details.results.length === 0 && details.mode !== "background")) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	if (details.mode === "background") {
		let text =
			theme.fg("warning", "⏳ ") +
			theme.fg("toolTitle", theme.bold("background ")) +
			theme.fg("accent", details.taskId ?? "") +
			theme.fg("muted", " started");
		if (details.notify) text += theme.fg("dim", " · completion will be reported automatically");
		text += `\n${theme.fg("dim", "Collect with subagent_task_output · manage with /agents")}`;
		return new Text(text, 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		return renderSingle(details.results[0], expanded, theme, mdTheme);
	}
	if (details.mode === "chain") {
		return renderChain(details.results, expanded, theme, mdTheme);
	}
	if (details.mode === "parallel") {
		return renderParallel(details.results, expanded, theme, mdTheme);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}

function renderSingle(r: RunRecord, expanded: boolean, theme: Theme, mdTheme: any): any {
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	if (expanded) {
		const container = new Container();
		container.addChild(new Text(recordHeaderLine(r, theme), 0, 0));
		for (const line of recordMetaLines(r, theme)) container.addChild(new Text(line, 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		const stats = usageLine([r], undefined, theme);
		if (stats) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(stats, 0, 0));
		}
		return container;
	}

	let text = recordHeaderLine(r, theme);
	for (const line of recordMetaLines(r, theme)) text += `\n${line}`;
	if (displayItems.length === 0) {
		if (!r.errorMessage) text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		text += `\n${renderDisplayItems(displayItems, false, theme, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const stats = usageLine([r], undefined, theme);
	if (stats) text += `\n${stats}`;
	return new Text(text, 0, 0);
}

function renderChain(results: RunRecord[], expanded: boolean, theme: Theme, mdTheme: any): any {
	const doneCount = results.filter((r) => r.status === "ok").length;
	const running = results.some((r) => r.status === "running" || r.status === "queued");
	const icon = running
		? theme.fg("warning", "⏳")
		: doneCount === results.length
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");

	if (expanded) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${doneCount}/${results.length} steps`)}`,
				0,
				0,
			),
		);

		for (const r of results) {
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = getFinalOutput(r.messages);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${statusIcon(r.status, theme)}${r.attempts > 1 ? theme.fg("dim", ` (attempt ${r.attempts})`) : ""}`,
					0,
					0,
				),
			);
			container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
			if (r.errorMessage && r.status !== "ok") {
				container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			}
			if (r.worktree) {
				container.addChild(new Text(theme.fg("muted", "worktree: ") + theme.fg("accent", r.worktree.path), 0, 0));
			}
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
			const stepUsage = formatUsageStats(r.usage, r.model);
			if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
		}

		const total = usageLine(results, "Total: ", theme);
		if (total) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(total, 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${doneCount}/${results.length} steps`)}`;
	for (const r of results) {
		const displayItems = getDisplayItems(r.messages);
		text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${statusIcon(r.status, theme)}`;
		if (displayItems.length === 0)
			text += `\n${theme.fg("muted", r.status === "running" ? "(running...)" : "(no output)")}`;
		else text += `\n${renderDisplayItems(displayItems, false, theme, 5)}`;
	}
	if (!running) {
		const total = usageLine(results, "Total: ", theme);
		if (total) text += `\n\n${total}`;
	}
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallel(results: RunRecord[], expanded: boolean, theme: Theme, mdTheme: any): any {
	const running = results.filter((r) => r.status === "running" || r.status === "queued").length;
	const failCount = results.filter((r) => r.status !== "running" && isRunFailed(r)).length;
	const successCount = results.length - running - failCount;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} tasks`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
		);

		for (const r of results) {
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = getFinalOutput(r.messages);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${statusIcon(r.status, theme)}`, 0, 0),
			);
			container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
			for (const line of recordMetaLines(r, theme)) container.addChild(new Text(line, 0, 0));
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
			const taskUsage = formatUsageStats(r.usage, r.model);
			if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
		}

		const total = usageLine(results, "Total: ", theme);
		if (total) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(total, 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
	for (const r of results) {
		const displayItems = getDisplayItems(r.messages);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${statusIcon(r.status, theme)}`;
		if (displayItems.length === 0)
			text += `\n${theme.fg("muted", r.status === "running" ? "(running...)" : "(no output)")}`;
		else text += `\n${renderDisplayItems(displayItems, false, theme, 5)}`;
	}
	if (!isRunning) {
		const total = usageLine(results, "Total: ", theme);
		if (total) text += `\n\n${total}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Task tool renderers (subagent_task_*)
// ---------------------------------------------------------------------------

export function renderTaskListResult(result: any, _options: { expanded: boolean }, theme: Theme): any {
	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no tasks)", 0, 0);
}

export function elapsed(startedAt: number, endedAt?: number): string {
	return formatDuration((endedAt ?? Date.now()) - startedAt);
}
