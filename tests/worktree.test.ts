import { agent, defaults, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createWorktree, exportPatch, git, removeWorktree, worktreeCwd } from "../src/worktree.ts";
import {
	claimWorktree,
	listWorktreeRecords,
	loadRunById,
	registerWorktree,
	unregisterWorktree,
	worktreeIsActive,
} from "../src/store.ts";
import { buildPlan } from "../src/plan.ts";
import { executePlan } from "../src/orchestrator.ts";
import { Runner } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fileURLToPath } from "node:url";

async function checked(args: string[], cwd: string) {
	const result = await git(args, cwd);
	assert.equal(result.code, 0, result.stderr);
	return result.stdout;
}
async function repository() {
	const dir = path.join(temp, randomUUID());
	fs.mkdirSync(path.join(dir, "package"), { recursive: true });
	await checked(["init", "--initial-branch=main"], dir);
	await checked(["config", "user.name", "Fixture"], dir);
	await checked(["config", "user.email", "fixture@example.invalid"], dir);
	fs.writeFileSync(path.join(dir, "package", "code.txt"), "initial\n");
	await checked(["add", "."], dir);
	await checked(["commit", "-m", "initial"], dir);
	return dir;
}

test("worktrees can be created from linked worktrees and preserve the working subdirectory", async () => {
	const repo = await repository();
	const linked = path.join(temp, randomUUID());
	await checked(["worktree", "add", "-b", "linked", linked], repo);
	const info = await createWorktree(path.join(linked, "package"), `run-${randomUUID()}`);
	try {
		assert.equal(info.subdirectory, "package");
		assert.ok(info.path.startsWith(path.join(repo, ".git", "subagents-ex")));
		assert.equal(fs.readFileSync(path.join(worktreeCwd(info), "code.txt"), "utf8"), "initial\n");
	} finally {
		assert.equal((await removeWorktree(info, true)).ok, true);
		await checked(["worktree", "remove", linked], repo);
	}
});

test("patch handoff includes committed, unstaged, staged, new and binary files without changing the worker index", async () => {
	const repo = await repository();
	const runId = `run-${randomUUID()}`;
	const info = await createWorktree(repo, runId);
	try {
		fs.writeFileSync(path.join(info.path, "committed.txt"), "worker commit\n");
		await checked(["add", "committed.txt"], info.path);
		await checked(["commit", "-m", "worker change"], info.path);
		fs.writeFileSync(path.join(info.path, "package", "code.txt"), "staged\n");
		await checked(["add", "package/code.txt"], info.path);
		fs.writeFileSync(path.join(info.path, "package", "code.txt"), "unstaged\n");
		fs.writeFileSync(path.join(info.path, "new.txt"), "new\n");
		fs.writeFileSync(path.join(info.path, "binary.bin"), Buffer.from([0, 1, 0, 255, 17]));
		const index = (await checked(["rev-parse", "--path-format=absolute", "--git-path", "index"], info.path)).trim();
		const originalIndex = fs.readFileSync(index);
		const artifact = await exportPatch(info, runId);
		assert.deepEqual(fs.readFileSync(index), originalIndex);
		assert.deepEqual(artifact.changedFiles.sort(), ["binary.bin", "committed.txt", "new.txt", "package/code.txt"]);
		assert.match(fs.readFileSync(artifact.patch!, "utf8"), /GIT binary patch/);
		await checked(["apply", "--check", artifact.patch!], repo);
		await checked(["apply", artifact.patch!], repo);
		assert.equal(fs.readFileSync(path.join(repo, "package", "code.txt"), "utf8"), "unstaged\n");
		assert.deepEqual(fs.readFileSync(path.join(repo, "binary.bin")), Buffer.from([0, 1, 0, 255, 17]));
	} finally {
		await removeWorktree(info, true);
	}
});

test("uncommitted subdirectories fail before creating a worktree", async () => {
	const repo = await repository();
	const subdir = path.join(repo, "untracked");
	fs.mkdirSync(subdir);
	const before = await checked(["worktree", "list", "--porcelain"], repo);
	await assert.rejects(() => createWorktree(subdir, `run-${randomUUID()}`));
	assert.equal(await checked(["worktree", "list", "--porcelain"], repo), before);
});

test("worktree registry preserves concurrent entries and ownership excludes cleanup/resume", async () => {
	const repo = await repository();
	const infos = await Promise.all([0, 1, 2].map(() => createWorktree(repo, `run-${randomUUID()}`)));
	for (const [i, info] of infos.entries()) registerWorktree(`run-${i}`, info);
	assert.ok(infos.every((info) => listWorktreeRecords().some((r) => r.path === info.path)));
	const release = await claimWorktree(infos[0], "owner");
	try {
		assert.ok(worktreeIsActive(listWorktreeRecords().find((r) => r.path === infos[0].path)!));
		await assert.rejects(() => claimWorktree(infos[0], "other"), /in use/);
	} finally {
		await release();
		for (const info of infos) {
			await removeWorktree(info, true);
			await unregisterWorktree(info.path);
		}
	}
});

test("parallel isolation and chain workspace metadata survive orchestration and persistence", async () => {
	const repo = await repository();
	const runner = new Runner({
		scheduler: new Scheduler(),
		invocation: {
			command: process.execPath,
			prefix: [fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "success"],
		},
	});
	for (const input of [
		{
			isolation: "worktree" as const,
			tasks: [
				{ agent: "test", task: "one" },
				{ agent: "test", task: "two" },
			],
		},
		{
			isolation: "worktree" as const,
			chain: [
				{ agent: "test", task: "one" },
				{ agent: "test", task: "use {previous}" },
			],
		},
	]) {
		const plan = buildPlan(input, [agent], { ...defaults, cwd: repo }, null);
		const result = await executePlan(plan, runner);
		assert.equal(result.details.status, "ok", JSON.stringify(result.content));
		for (const run of result.details.results) {
			assert.ok(run.worktree);
			assert.deepEqual(loadRunById(run.id)?.worktree, run.worktree);
			assert.ok(run.artifacts?.manifest);
			assert.ok(fs.existsSync(run.artifacts.manifest));
			assert.match((result.content[0] as any).text, new RegExp(run.id));
		}
		const paths = new Set(result.details.results.map((r) => r.worktree!.path));
		assert.equal(paths.size, plan.mode === "parallel" ? 2 : 1);
		for (const treePath of paths) {
			const info = result.details.results.find((r) => r.worktree!.path === treePath)!.worktree!;
			await removeWorktree(info, true);
			await unregisterWorktree(treePath);
		}
	}
});

test("setup failure has explicit error status even with no run records", async () => {
	const plan = buildPlan({ isolation: "worktree", chain: [{ agent: "test", task: "one" }] }, [agent], defaults, null);
	const result = await executePlan(plan, new Runner());
	assert.equal(result.details.status, "error");
	assert.equal(result.details.results.length, 0);
	assert.match(result.details.errorMessage!, /git repository/);
});
