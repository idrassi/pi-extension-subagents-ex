/** Worktrees plus an explicit patch handoff, including new files and worker commits. */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ARTIFACTS_DIR } from "./store.ts";
import type { RunArtifacts, WorktreeInfo } from "./types.ts";

export function git(
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: env ?? process.env },
			(error, stdout, stderr) => {
				resolve({
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr || error?.message || "",
				});
			},
		);
	});
}

async function checkedGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
	const r = await git(args, cwd, env);
	if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout;
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
	const r = await git(["rev-parse", "--show-toplevel"], cwd);
	return r.code === 0 ? r.stdout.trim() || null : null;
}

export async function createWorktree(cwd: string, runId: string): Promise<WorktreeInfo> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot) throw new Error(`Not inside a git repository: ${cwd}`);
	const commonDir = (await checkedGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot)).trim();
	const baseCommit = (await checkedGit(["rev-parse", "HEAD"], repoRoot)).trim();
	const subdirectory = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(cwd));
	if (
		subdirectory &&
		(
			await checkedGit(["cat-file", "-t", `${baseCommit}:${subdirectory.split(path.sep).join("/")}`], repoRoot)
		).trim() !== "tree"
	) {
		throw new Error(`Working subdirectory is absent from committed state: ${subdirectory}`);
	}
	const safeId = runId.replace(/[^\w.-]+/g, "-");
	const worktreePath = path.join(commonDir, "subagents-ex", safeId);
	const branch = `subagents-ex/${safeId}`;
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	// IDs are unique: collisions are errors, never permission to destroy earlier work.
	await checkedGit(["worktree", "add", "-b", branch, worktreePath, baseCommit], repoRoot);
	const info = { path: worktreePath, branch, repoRoot, baseCommit, subdirectory };
	return info;
}

export function worktreeCwd(info: WorktreeInfo): string {
	return path.join(info.path, info.subdirectory ?? "");
}

export async function exportPatch(info: WorktreeInfo, runId: string): Promise<RunArtifacts> {
	const baseCommit = info.baseCommit ?? (await checkedGit(["merge-base", "HEAD", info.branch], info.repoRoot)).trim();
	fs.mkdirSync(ARTIFACTS_DIR, { recursive: true, mode: 0o700 });
	const index = path.join(ARTIFACTS_DIR, `index-${randomUUID()}`);
	const env = { ...process.env, GIT_INDEX_FILE: index };
	try {
		await checkedGit(["read-tree", baseCommit], info.path, env);
		await checkedGit(["add", "-A", "--", "."], info.path, env);
		const changedFiles = (await checkedGit(["diff", "--cached", "--name-only", "-z", baseCommit, "--"], info.path, env))
			.split("\0")
			.filter(Boolean);
		if (!changedFiles.length) return { changedFiles, baseCommit, verification: [] };
		const patch = path.join(ARTIFACTS_DIR, `${runId}.patch`);
		const diff = await checkedGit(["diff", "--cached", "--binary", "--full-index", baseCommit, "--"], info.path, env);
		fs.writeFileSync(patch, diff, { mode: 0o600 });
		return { patch, changedFiles, baseCommit, verification: [] };
	} finally {
		fs.rmSync(index, { force: true });
		fs.rmSync(`${index}.lock`, { force: true });
	}
}

export async function removeWorktree(info: WorktreeInfo, force = false): Promise<{ ok: boolean; error?: string }> {
	const result = await git(["worktree", "remove", ...(force ? ["--force"] : []), info.path], info.repoRoot);
	if (result.code !== 0 && fs.existsSync(info.path)) return { ok: false, error: result.stderr.trim() };
	const branch = await git(["branch", force ? "-D" : "-d", info.branch], info.repoRoot);
	if (branch.code !== 0 && (await git(["show-ref", "--verify", `refs/heads/${info.branch}`], info.repoRoot)).code === 0)
		return { ok: false, error: branch.stderr.trim() };
	return { ok: true };
}
