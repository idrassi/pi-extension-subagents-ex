/** Explicit bounded reads keep bulk run data out of routine control-plane results. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToBytes } from "./format.ts";
import { boundedResult } from "./results.ts";
import { getRunOutputPage, listRunsPage } from "./store.ts";
import { numberControl } from "./validation.ts";

export function registerHistoryTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_history", label: "Subagent History",
		description: "List saved run summaries without loading transcripts. Cursor-paginated, up to 50 runs per page; use subagent_run_output for full output.",
		parameters: Type.Object({ cursor: Type.Optional(Type.String({ maxLength: 1024 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
		async execute(_id, rawParams) {
			const params = rawParams as { cursor?: string; limit?: number };
			let limit = numberControl(params.limit ?? 30, "limit", 1, 50, true)!;
			const summarize = (page: ReturnType<typeof listRunsPage>) => page.runs.map((run) => ({
				id: run.id, agent: truncateToBytes(run.agent, 128).text, status: run.status,
				task: truncateToBytes(run.task, 256).text, cost: run.cost, ts: run.ts, durationMs: run.durationMs,
			}));
			let page = listRunsPage({ ...params, limit });
			let runs = summarize(page);
			while (Buffer.byteLength(JSON.stringify({ runs, nextCursor: page.nextCursor })) > 24 * 1024 && limit > 1) {
				limit = Math.max(1, Math.floor(limit / 2));
				page = listRunsPage({ ...params, limit });
				runs = summarize(page);
			}
			return boundedResult(runs.map((run) => `${run.id} ${run.agent} ${run.status} $${run.cost.toFixed(4)} — ${run.task}`).join("\n") || "No saved runs.",
				{ runs, nextCursor: page.nextCursor });
		},
	});
	pi.registerTool({
		name: "subagent_run_output", label: "Subagent Run Output",
		description: "Read saved full output without charging usage again. UTF-8 byte offsets; up to 4096 bytes/900 lines per page. Follow nextOffset until absent. Full sessions and run artifacts remain on disk.",
		parameters: Type.Object({ id: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })) }),
		async execute(_id, rawParams) {
			const params = rawParams as { id: string; offset?: number; limit?: number };
			const limit = numberControl(params.limit ?? 4096, "limit", 1, 4096, true)!;
			const page = getRunOutputPage(params.id, { offset: params.offset, limit });
			// Account for the outer result's line limit without skipping unread bytes.
			let text = page.text;
			let position = -1;
			for (let i = 0; i < 900; i++) {
				position = text.indexOf("\n", position + 1);
				if (position === -1) break;
				if (i === 899) text = text.slice(0, position + 1);
			}
			const end = page.offset + Buffer.byteLength(text, "utf8");
			const details = { runId: params.id, offset: page.offset, totalBytes: page.totalBytes,
				nextOffset: end < page.totalBytes ? end : undefined, outputFile: page.outputFile };
			return boundedResult(`${params.id} output bytes ${page.offset}–${end}/${page.totalBytes}\n${text}`, details);
		},
	});
}
