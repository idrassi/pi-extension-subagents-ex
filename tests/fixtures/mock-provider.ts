/** Local deterministic provider: exercises the real pi runtime without a network or API key. */
import * as fs from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function mockProvider(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fixture_wrap",
		label: "Nested fixture",
		description: "Exercise ctx.executeTool provenance, including an unrelated tool charge.",
		parameters: Type.Object({ nested: Type.Boolean() }),
		async execute(_id, args, _signal, _update, ctx) {
			const outcome = args.nested
				? await ctx.executeTool("fixture_wrap", { nested: false })
				: await ctx.executeTool("subagent", { agent: "fixture-child", task: "complete the nested fixture" });
			if (outcome.isError) throw new Error(JSON.stringify(outcome));
			return {
				content: [{ type: "text", text: "wrapped fixture complete" }],
				details: {},
				usage: {
					input: args.nested ? 0 : 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: args.nested ? 0 : 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: args.nested ? 0 : 0.002 },
				},
			};
		},
	});
	pi.registerTool({
		name: "fixture_charge", label: "Unrelated billable fixture", description: "Unrelated usage and non-run metadata.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "billable fixture" }], details: { results: [null] },
				usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0.002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } } };
		},
	});
	pi.registerTool({
		name: "fixture_collect", label: "Free collection fixture", description: "Collect background metadata without charging it again.",
		parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			const queued = await ctx.executeTool("subagent", {
				agent: "fixture-child", task: "complete the nested fixture", runInBackground: true, notify: false,
			});
			if (queued.isError) throw new Error(JSON.stringify(queued));
			const id = (queued.result.details as { taskId: string }).taskId;
			const collected = await ctx.executeTool("subagent_task_output", { id, wait: true });
			if (collected.isError) throw new Error(JSON.stringify(collected));
			const charged = await ctx.executeTool("fixture_charge", {});
			if (charged.isError) throw new Error(JSON.stringify(charged));
			// Pi attaches only the unrelated nested charge here; copied run details
			// from free collection must not be interpreted as charge provenance.
			return { content: collected.result.content, details: collected.result.details };
		},
	});
	let nativeFixture = false;
	pi.on("before_agent_start", (event) => {
		nativeFixture = "prompt" in event && event.prompt.includes("COMPACT_THEN_HANG");
	});
	pi.on("agent_before_settle", () => {
		if (!nativeFixture) return;
		nativeFixture = false;
		// A real pi boundary commit writes this native compaction usage to the session.
		return {
			entries: [
				{
					type: "compaction", summary: "Local fixture compaction", firstKeptEntryId: null,
					usage: { input: 300, output: 150, cacheRead: 0, cacheWrite: 0, totalTokens: 450,
						cost: { input: 0.15, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
				},
				{ type: "custom_message", customType: "native-fixture", content: "SLOW_CHILD", display: false },
			],
			continue: true,
		};
	});
	pi.registerProvider("subagents-test", {
		baseUrl: "http://127.0.0.1/unused",
		apiKey: "local-fixture",
		api: "subagents-test-api",
		models: [
			{
				id: "fixture",
				name: "Local fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1000,
			},
			{
				id: "fixture-reasoning",
				name: "Local reasoning fixture",
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				input: ["text"],
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1000,
			},
			{
				id: "fixture-limited-reasoning",
				name: "Local limited reasoning fixture",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1000,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const user = context.messages.filter((m) => m.role === "user").at(-1);
			const prompt =
				typeof user?.content === "string"
					? user.content
					: (user?.content
							.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join("\n") ?? "");
			if (process.env.SUBAGENTS_TEST_PROVIDER_LOG)
				fs.appendFileSync(
					process.env.SUBAGENTS_TEST_PROVIDER_LOG,
					`${JSON.stringify({
						pid: process.pid,
						treeId: process.env.PI_SUBAGENTS_EX_TREE_ID,
						prompt,
						model: model.id,
						reasoning: options?.reasoning,
						aborted: options?.signal?.aborted,
					})}\n`,
				);
			const slow = prompt.includes("SLOW_CHILD");
			const looping = prompt.includes("LOOP_TOOLS") || slow;
			const background = prompt.includes("BACKGROUND_DELEGATE");
			const wrapped = prompt.includes("WRAPPED_DELEGATE");
			const collected = prompt.includes("COLLECT_WRAPPED_DELEGATE");
			const delegateTool = collected ? "fixture_collect" : wrapped ? "fixture_wrap" : "subagent";
			const delegate =
				prompt.includes("DELEGATE") &&
				!context.messages.some((m) => m.role === "toolResult" && m.toolName === delegateTool);
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: delegate
					? [
							{
								type: "toolCall",
								id: `delegate-${Date.now()}`,
								name: delegateTool,
								arguments: collected ? {} : wrapped ? { nested: prompt.includes("NESTED_WRAPPED_DELEGATE") } : {
									agent: process.env.SUBAGENTS_TEST_CHILD_AGENT ?? "fixture-child",
									task:
										background || prompt.includes("FOREGROUND_SLOW_DELEGATE")
											? "SLOW_CHILD"
											: "complete the nested fixture",
									runInBackground: background,
									notify: false,
								},
							},
						]
					: looping
						? [
								{
									type: "toolCall",
									id: `call-${Date.now()}`,
									name: "bash",
									arguments: { command: slow ? "sleep 30" : "printf 'verified\\n'" },
								},
							]
						: [{ type: "text", text: `fixture complete; history=${context.messages.length}` }],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
				stopReason: looping || delegate ? "toolUse" : "stop",
				timestamp: Date.now(),
			};
			const finish = () => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				stream.end();
			};
			if (prompt.includes("STREAM_PROGRESS")) {
				void (async () => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					for (let i = 0; i < 12; i++) {
						await new Promise((r) => setTimeout(r, 75));
						stream.push({ type: "text_delta", contentIndex: 0, delta: ".", partial: message });
					}
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				})();
			} else if (background && !delegate) {
				// Let the background worker incur one request, then end without collecting it.
				void (async () => {
					for (let i = 0; i < 100; i++) {
						if (
							fs.readFileSync(process.env.SUBAGENTS_TEST_PROVIDER_LOG!, "utf8")
								.split("\n")
								.some(
									(line) =>
										line.includes('"prompt":"Task: SLOW_CHILD"') &&
										line.includes(`"treeId":${JSON.stringify(process.env.PI_SUBAGENTS_EX_TREE_ID)}`),
								)
						) {
							await new Promise((r) => setTimeout(r, 100));
							break;
						}
						await new Promise((r) => setTimeout(r, 50));
					}
					finish();
				})();
			} else queueMicrotask(finish);
			return stream;
		},
	});
}
