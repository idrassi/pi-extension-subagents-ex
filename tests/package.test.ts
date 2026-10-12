import { temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(
	path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle/cli.js",
);

test("release archive runs a bundled agent without the checkout or local pi SDK dependencies", { timeout: 45000 }, async () => {
	const npmCli = process.env.npm_execpath;
	const { stdout: packOutput } = await exec(
		npmCli ? process.execPath : "npm",
		[...(npmCli ? [npmCli] : []), "pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", temp],
		{ cwd: root, timeout: 15000, maxBuffer: 4_000_000 },
	);
	const [pack] = JSON.parse(packOutput) as { filename: string; files: { path: string }[] }[];
	assert.ok(pack.files.every((file) => !/^(tests|benchmarks|scripts|\.github|\.git)\//.test(file.path)));
	assert.ok(pack.files.every((file) => !/^node_modules\/(@earendil-works|typescript|@types)\//.test(file.path)));

	const agentDir = path.join(temp, "standalone-agent");
	const extensionDir = path.join(agentDir, "extensions", "subagents-ex");
	fs.mkdirSync(extensionDir, { recursive: true });
	await exec("tar", ["-xzf", path.join(temp, pack.filename), "-C", extensionDir, "--strip-components=1"]);
	assert.ok(fs.existsSync(path.join(extensionDir, "prompts", "implement.md")));
	assert.ok(fs.existsSync(path.join(extensionDir, "node_modules", "ajv", "package.json")));
	assert.ok(fs.existsSync(path.join(extensionDir, "node_modules", "proper-lockfile", "package.json")));
	fs.copyFileSync(
		fileURLToPath(new URL("./fixtures/mock-provider.ts", import.meta.url)),
		path.join(agentDir, "extensions", "mock-provider.ts"),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			packages: [],
			enableInstallTelemetry: false,
			defaultProjectTrust: "always",
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	const run = exec(
		process.execPath,
		[cli, "--print", "--mode", "json", "--no-session", "--model", "subagents-test/fixture", "DELEGATE"],
		{
			cwd: temp,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PI_SUBAGENTS_EX_DEPTH: "0",
				SUBAGENTS_TEST_CHILD_AGENT: "worker",
			},
			timeout: 25000,
			maxBuffer: 4_000_000,
		},
	);
	run.child.stdin?.end();
	const { stdout, stderr } = await run;
	const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
	const result = events.find((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
	assert.ok(result, `No delegation result: ${stderr}\n${stdout}`);
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(result.result.details.status, "ok", JSON.stringify(result));
	assert.equal(result.result.details.results[0].agent, "worker");
	assert.match(JSON.stringify(result.result.content), /fixture complete/);
	assert.ok(fs.readdirSync(path.join(agentDir, "subagents-ex", "runs")).length > 0);
});
