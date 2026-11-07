/**
 * Authorization for extension-owned project agents.
 *
 * Pi 1.5.0 does not include .pi/agents in its trust-sensitive resources, so
 * isProjectTrusted() can be implicitly true even with defaultProjectTrust never.
 * ExtensionContext exposes neither decision provenance nor the active trust
 * store (SDK hosts may use a different agentDir). Reading a guessed trust.json,
 * observing project_trust, or inspecting argv would not establish authorization.
 *
 * Consequently ALL project definitions require per-definition session approval,
 * including under saved, CLI, temporary, or default pi trust. Headless callers
 * cannot grant new approvals. Approvals are memory-only, never restored from
 * sessions/runs, and cover the loaded AgentConfig snapshot, not a sandbox or
 * immutable child resources. Discovery/metadata must never prompt for approval.
 */
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig, type AgentDiscoveryResult } from "./agents.ts";

/** Include every loaded field, especially prompt, settings, description and source path. */
function definitionKey(agent: AgentConfig): string {
	return createHash("sha256")
		.update(JSON.stringify(Object.entries(agent).sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
}

export class ProjectAgentTrust {
	private sessionId: string | undefined;
	private generation = 0;
	private approvals = new Set<string>();

	private useSession(ctx: ExtensionContext): string {
		const id = ctx.sessionManager.getSessionId();
		if (this.sessionId !== id) {
			this.approvals.clear();
			this.sessionId = id;
			this.generation++;
		}
		return id;
	}

	/** Read-only authorization check: no UI, trust-store reads, or persisted approvals. */
	isAuthorized(agent: AgentConfig, ctx: ExtensionContext): boolean {
		this.useSession(ctx);
		return agent.source !== "project" || this.approvals.has(definitionKey(agent));
	}

	/** Preserve bundled/user fallbacks when an unauthorized project definition shadows them. */
	discover(ctx: ExtensionContext): AgentDiscoveryResult {
		this.useSession(ctx);
		const base = discoverAgents(ctx.cwd, "user");
		const agents = new Map(base.agents.map((agent) => [agent.name, agent]));
		for (const agent of discoverAgents(ctx.cwd, "both").agents) {
			if (agent.source === "project" && this.isAuthorized(agent, ctx)) agents.set(agent.name, agent);
		}
		// Project parse errors can contain repository-controlled text too. No valid,
		// approvable snapshot exists for them, so never inject them into the prompt.
		return { ...base, agents: Array.from(agents.values()) };
	}

	/** Called only for the already-resolved snapshots selected by an execution request. */
	async authorize(agents: AgentConfig[], ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		const sessionId = this.useSession(ctx);
		const generation = this.generation;
		const abortSignal = signal ?? ctx.signal;
		abortSignal?.throwIfAborted();
		const unapproved = new Map(
			agents.filter((agent) => !this.isAuthorized(agent, ctx)).map((agent) => [definitionKey(agent), agent]),
		);
		if (!unapproved.size) return;
		if (!ctx.hasUI)
			throw new Error(
				"Project agents require per-definition approval in an interactive or RPC session; pi project trust alone is insufficient and unapproved headless execution is disabled",
			);
		const confirmed = await ctx.ui.confirm(
			"Run project-local agents?",
			`${Array.from(unapproved, ([key, agent]) => `${JSON.stringify(agent.name)}: ${JSON.stringify(agent.filePath)}\nLoaded definition SHA-256: ${key}`).join("\n")}\nThese repository-controlled definitions will be approved for this session only. Pi project trust does not waive this confirmation.`,
			{ signal: abortSignal },
		);
		abortSignal?.throwIfAborted();
		if (ctx.sessionManager.getSessionId() !== sessionId || this.generation !== generation)
			throw new Error("Session changed while approving project agents; request approval again");
		if (confirmed !== true) throw new Error("Project agents were not approved");
		// Record the pre-dialog keys, never a definition changed while awaiting UI.
		for (const [key, agent] of unapproved)
			if (definitionKey(agent) !== key) throw new Error("Project agent definition changed during approval");
		for (const key of unapproved.keys()) this.approvals.add(key);
	}
}
