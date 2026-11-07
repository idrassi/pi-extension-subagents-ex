/** TUI views use bounded DTO previews and artifact references, never transcripts. */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { aggregateUsage, formatDuration, formatUsageStats, truncateToBytes } from "./format.ts";
import { boundedResult, compactDetails } from "./results.ts";
import type { RunResult, RunStatus, SubagentDetails } from "./types.ts";
import { isRunFailed } from "./types.ts";

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

function recordHeaderLine(run: RunResult, theme: Theme): string {
	let line = `${statusIcon(run.status, theme)} ${theme.fg("toolTitle", theme.bold(run.agent))}${theme.fg("muted", ` (${run.agentSource})`)}`;
	if (run.status !== "ok" && run.status !== "running") line += ` ${theme.fg("error", `[${run.status}]`)}`;
	if (run.attempts > 1) line += theme.fg("dim", ` attempt ${run.attempts}`);
	return line;
}

function recordMetaLines(run: RunResult, theme: Theme): string[] {
	const lines = [theme.fg("dim", `run: ${run.id}${run.treeId ? ` · tree: ${run.treeId}` : ""}`)];
	if (run.errorMessage && run.status !== "ok") lines.push(theme.fg("error", `Error: ${run.errorMessage}`));
	if (run.worktree) lines.push(theme.fg("muted", "worktree: ") + theme.fg("accent", run.worktree.path) + theme.fg("dim", ` (branch ${run.worktree.branch})`));
	return lines;
}

function artifactLines(run: RunResult, theme: Theme): string[] {
	const lines = [theme.fg("dim", `Full output: subagent_run_output · runId: ${run.id}`)];
	for (const key of ["output", "manifest", "patch"] as const) {
		const file = run.artifacts?.[key];
		if (file) lines.push(theme.fg("muted", `${key}: `) + theme.fg("accent", file));
	}
	if (run.sessionFile) lines.push(theme.fg("muted", "session: ") + theme.fg("accent", run.sessionFile));
	if (run.metadataTruncated) lines.push(theme.fg("dim", "Additional metadata is in the saved run."));
	return lines;
}

function usageLine(records: RunResult[], prefix: string | undefined, theme: Theme): string {
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

function fallbackResult(result: any): Text {
	const content = result.content?.find((part: any) => part.type === "text");
	const bounded = boundedResult(content?.text ?? "(no output)", undefined);
	return new Text(bounded.content[0].type === "text" ? bounded.content[0].text : "(no output)", 0, 0);
}

export function renderSubagentResult(result: any, options: { expanded: boolean }, theme: Theme): any {
	if (!Array.isArray(result.details?.results)) return fallbackResult(result);
	let details: SubagentDetails;
	try {
		// Old sessions may still contain RunRecords. Project them before rendering;
		// expanding must not iterate/render their tool calls or nested transcripts.
		details = compactDetails(result.details);
	} catch {
		return fallbackResult(result);
	}
	if (details.mode === "background") {
		let text = theme.fg("warning", "⏳ ") + theme.fg("toolTitle", theme.bold("background ")) + theme.fg("accent", details.taskId ?? "") + theme.fg("muted", " started");
		if (details.notify) text += theme.fg("dim", " · completion will be reported automatically");
		text += `\n${theme.fg("dim", "Collect with subagent_task_output · manage with /agents")}`;
		return new Text(text, 0, 0);
	}
	if (!details.results.length) return fallbackResult(result);
	if (details.mode === "single" && details.results.length === 1)
		return renderSingle(details.results[0], options.expanded, theme);
	const running = details.results.filter((run) => run.status === "running" || run.status === "queued").length;
	const failed = details.results.filter(isRunFailed).length;
	const successful = details.results.length - running - failed;
	const icon = running ? theme.fg("warning", "⏳") : failed ? theme.fg("warning", "◐") : theme.fg("success", "✓");
	const label = details.mode === "chain" ? `${successful}/${details.results.length} steps` : running
		? `${successful + failed}/${details.results.length} done, ${running} running` : `${successful}/${details.results.length} tasks`;
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(`${details.mode} `))}${theme.fg("accent", label)}`;
	if (options.expanded) {
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		for (const run of details.results) {
			container.addChild(new Spacer(1));
			if (run.step) container.addChild(new Text(theme.fg("muted", `─── Step ${run.step} ───`), 0, 0));
			container.addChild(renderSingle(run, true, theme));
		}
		const total = usageLine(details.results, "Total: ", theme);
		if (total) container.addChild(new Text(total, 0, 0));
		return container;
	}
	let text = header;
	for (const run of details.results) {
		text += `\n\n${recordHeaderLine(run, theme)}\n${theme.fg("dim", `run: ${run.id}`)}\n${collapsedOutput(run, theme)}`;
	}
	const total = usageLine(details.results, "Total: ", theme);
	if (total) text += `\n\n${total}`;
	text += `\n${theme.fg("muted", "(Ctrl+O for previews and artifact references)")}`;
	return new Text(text, 0, 0);
}

function collapsedOutput(run: RunResult, theme: Theme): string {
	if (!run.output) return theme.fg("muted", run.status === "running" || run.status === "queued" ? "(running...)" : "(no output preview)");
	const lines = run.output.split("\n");
	const clipped = truncateToBytes(lines.slice(0, 3).join("\n"), 512);
	return theme.fg("toolOutput", clipped.text) + (clipped.truncated || lines.length > 3 || run.outputTruncated ? theme.fg("dim", " … (preview)") : "");
}

function renderSingle(run: RunResult, expanded: boolean, theme: Theme): any {
	if (!expanded) {
		const lines = [recordHeaderLine(run, theme), ...recordMetaLines(run, theme), collapsedOutput(run, theme)];
		const usage = usageLine([run], undefined, theme);
		if (usage) lines.push(usage);
		return new Text(lines.join("\n"), 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(recordHeaderLine(run, theme), 0, 0));
	for (const line of recordMetaLines(run, theme)) container.addChild(new Text(line, 0, 0));
	if (run.task) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task preview ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", run.task), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output preview ───"), 0, 0));
	if (run.output) container.addChild(new Markdown(run.output.trim(), 0, 0, getMarkdownTheme()));
	else container.addChild(new Text(theme.fg("muted", "(no output preview)"), 0, 0));
	for (const line of artifactLines(run, theme)) container.addChild(new Text(line, 0, 0));
	const usage = usageLine([run], undefined, theme);
	if (usage) container.addChild(new Text(usage, 0, 0));
	return container;
}

// ---------------------------------------------------------------------------
// Task tool renderers (subagent_task_*)
// ---------------------------------------------------------------------------

export function renderTaskListResult(result: any, _options: { expanded: boolean }, _theme: Theme): any {
	return fallbackResult(result);
}

export function elapsed(startedAt: number, endedAt?: number): string {
	return formatDuration((endedAt ?? Date.now()) - startedAt);
}
