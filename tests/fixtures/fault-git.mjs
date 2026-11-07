// PATH-scoped Git wrapper. Only temporary-index exports are affected; all real
// commands use an absolute Git executable and never change global configuration.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const directory = process.env.PI_FAULT_GIT_DIRECTORY;
const index = process.env.GIT_INDEX_FILE;
const exporting = index && path.dirname(index) === process.env.PI_FAULT_GIT_ARTIFACTS;
const log = (data) => fs.appendFileSync(path.join(directory, "git.jsonl"), `${JSON.stringify({ pid: process.pid, args, index, ...data })}\n`);

if (exporting) {
	log({ phase: "start" });
	if (process.env.PI_FAULT_GIT_MODE === "pause-diff" && args[0] === "diff" && args.includes("--binary")) {
		fs.writeFileSync(path.join(directory, "export-ready.json"), JSON.stringify({ pid: process.pid, index }));
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(path.join(directory, "release-export"))) {
			if (Date.now() > deadline) throw new Error("Fault Git barrier was not released");
			await delay(10);
		}
	}
}
const result = spawnSync(process.env.PI_FAULT_GIT_REAL, args, {
	env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 10000,
});
if (exporting) log({ phase: "exit", childPid: result.pid, code: result.status });
if (result.error) throw result.error;
if (exporting && result.status === 0) {
	if (process.env.PI_FAULT_GIT_MODE === "fail-add" && args[0] === "add") {
		// Fail after populating the disposable index, including a leftover lock.
		fs.writeFileSync(`${index}.lock`, "injected interrupted add\n");
		log({ phase: "injected", indexExists: fs.existsSync(index), lockExists: fs.existsSync(`${index}.lock`) });
		process.stderr.write("fault git add: permission denied\n");
		process.exit(73);
	}
	if (process.env.PI_FAULT_GIT_MODE === "fail-diff" && args[0] === "diff" && args.includes("--binary")) {
		log({ phase: "injected", indexExists: fs.existsSync(index) });
		process.stderr.write("fault git diff: export failed\n");
		process.exit(74);
	}
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
