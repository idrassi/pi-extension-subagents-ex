/**
 * Agent discovery and configuration.
 *
 * Agents are markdown files with YAML frontmatter. Three sources are merged
 * (later sources override earlier ones for the same `name`):
 *
 *   1. bundled  — shipped with this extension (<extension>/agents)
 *   2. user     — ~/.pi/agent/agents
 *   3. project  — .pi/agents (only when scope includes it, trust-gated)
 *
 * Frontmatter schema (backwards compatible with pi's subagent example):
 *
 *   name: worker                (required)
 *   description: ...            (required)
 *   model: anthropic/claude-sonnet-4-5        (optional, inherits dispatcher model)
 *   thinking: low|medium|high|...             (optional, inherits dispatcher thinking level)
 *   tools: read, grep, bash                   (optional allowlist)
 *   excludeTools: write, edit                 (optional denylist, ignored when `tools` set)
 *   skills: false                             (default true — pass --no-skills)
 *   contextFiles: false                       (default true — pass --no-context-files)
 *   extensions: false                         (default true — pass --no-extensions)
 *   maxTurns: 20                              (orchestrator-enforced turn budget)
 *   timeout: 600                              (wall-clock budget in seconds)
 *   retries: 1                                (retries on failure, orchestrator-enforced)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "./types.ts";
import { MAX_RETRIES, MAX_TIMEOUT_SECONDS, numberControl } from "./validation.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	skills: boolean;
	contextFiles: boolean;
	extensions: boolean;
	maxTurns?: number;
	timeoutSeconds?: number;
	retries?: number;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	bundledAgentsDir: string;
	userAgentsDir: string;
	errors: string[];
}

export const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
export const BUNDLED_PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown;
	excludeTools?: unknown;
	skills?: unknown;
	contextFiles?: unknown;
	extensions?: unknown;
	maxTurns?: unknown;
	timeout?: unknown;
	retries?: unknown;
};

function asStringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const items = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function asBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (v === "true" || v === "yes" || v === "1") return true;
		if (v === "false" || v === "no" || v === "0") return false;
	}
	return fallback;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim().toLowerCase() as ThinkingLevel;
	return THINKING_LEVELS.includes(v) ? v : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"], errors: string[]): AgentConfig[] {
	const agents: AgentConfig[] = [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

			if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
				continue;
			}

			const tools = asStringList(frontmatter.tools);
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				systemPrompt: body,
				source,
				filePath,
				model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
				thinking: asThinkingLevel(frontmatter.thinking),
				tools,
				// A denylist only makes sense without an allowlist.
				excludeTools: tools ? undefined : asStringList(frontmatter.excludeTools),
				skills: asBool(frontmatter.skills, true),
				contextFiles: asBool(frontmatter.contextFiles, true),
				extensions: asBool(frontmatter.extensions, true),
				maxTurns: numberControl(frontmatter.maxTurns, "maxTurns", 1, 100_000, true),
				timeoutSeconds: numberControl(frontmatter.timeout, "timeout", 0.001, MAX_TIMEOUT_SECONDS),
				retries: numberControl(frontmatter.retries, "retries", 0, MAX_RETRIES, true),
			});
		} catch (err) {
			errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
			// A single malformed file must not break discovery of the rest.
			continue;
		}
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Discover agents for the given scope. Bundled agents are always available as
 * the base layer; user agents are included unless scope is "project"; project
 * agents only for "project"/"both" (trust is enforced by the caller).
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const errors: string[] = [];
	const bundled = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled", errors);
	const user = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user", errors);
	const project = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", errors);

	const byName = new Map<string, AgentConfig>();
	for (const agent of bundled) byName.set(agent.name, agent);
	for (const agent of user) byName.set(agent.name, agent);
	for (const agent of project) byName.set(agent.name, agent);

	return {
		agents: Array.from(byName.values()),
		projectAgentsDir,
		bundledAgentsDir: BUNDLED_AGENTS_DIR,
		userAgentsDir,
		errors,
	};
}

export function formatAvailableAgents(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n");
}
