/** Offline evaluation primitives. No SDK imports and no provider/network activity. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
	try {
		// The caller's shell may select an unrelated repository/index/object store
		// or inject config. Only explicit helper overrides may redirect Git state.
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const result = await execute("git", ["--no-replace-objects", "-c", "core.quotepath=false",
			"-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol", "-c", "core.autocrlf=false", ...args], {
			cwd, env: { ...inherited, GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
			timeout: 15000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string; message: string };
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
	}
}
export async function checkedGit(args: string[], cwd: string): Promise<string> {
	const result = await git(args, cwd);
	if (result.code) throw new Error(`git ${args[0]}: ${result.stderr}`);
	return result.stdout;
}
export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export interface EvaluationCase { id: string; task: string; dir: string; allowlist: readonly string[] }
function safeRelative(file: string): boolean {
	return !!file && !file.includes("\\") && !file.includes("\0") && !path.posix.isAbsolute(file) &&
		file.split("/").every((part) => part !== ".." && part !== "." && part !== "" && part !== ".git");
}
export function loadCases(corpus: string): EvaluationCase[] {
	return fs.readdirSync(corpus).sort().filter((name) => fs.statSync(path.join(corpus, name)).isDirectory()).map((name) => {
		const dir = path.join(corpus, name);
		const raw = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
		const allowlist: unknown = raw.allowlist ?? ["lib.mjs"];
		if (raw.id !== name || !/^[a-z0-9-]+$/.test(raw.id) || typeof raw.task !== "string" ||
			!Array.isArray(allowlist) || !allowlist.length || !allowlist.every((f) => typeof f === "string" && safeRelative(f)))
			throw new Error(`Invalid evaluation case: ${dir}`);
		return Object.freeze({ id: raw.id, task: raw.task, dir, allowlist: Object.freeze([...allowlist]) });
	});
}
/** Always use a fresh checkout; never overlay a reference onto a dirty initial tree. */
export function materializeCase(task: EvaluationCase, cwd: string, reference = false): void {
	if (fs.existsSync(cwd) && fs.readdirSync(cwd).length) throw new Error(`Workspace is not empty: ${cwd}`);
	fs.mkdirSync(cwd, { recursive: true });
	const tree = path.join(task.dir, reference ? "reference" : "initial");
	if (fs.existsSync(tree)) {
		for (const entry of fs.readdirSync(tree)) fs.cpSync(path.join(tree, entry), path.join(cwd, entry), { recursive: true });
	} else fs.copyFileSync(path.join(task.dir, reference ? "solution.mjs" : "initial.mjs"), path.join(cwd, "lib.mjs"));
}
export async function checkAcceptance(task: EvaluationCase, cwd: string) {
	try {
		const result = await execute(process.execPath, [path.join(task.dir, "check.mjs")], {
			cwd, env: { ...process.env, EVAL_WORKSPACE: cwd }, timeout: 15000, maxBuffer: 1024 * 1024,
		});
		return { passed: true, output: result.stdout + result.stderr };
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message: string };
		return { passed: false, output: (e.stdout ?? "") + (e.stderr ?? "") || e.message };
	}
}
interface FileStamp { readonly path: string; readonly hash: string; readonly mode: number }
/** Walk disk, not the index: ignored files and assume-unchanged/skip-worktree cannot hide changes. */
function snapshot(cwd: string): readonly FileStamp[] {
	const result: FileStamp[] = [];
	const walk = (relative: string) => {
		for (const name of fs.readdirSync(path.join(cwd, relative)).sort()) {
			if (!relative && name === ".git") continue;
			const file = relative ? `${relative}/${name}` : name;
			const absolute = path.join(cwd, file), stat = fs.lstatSync(absolute);
			if (stat.isDirectory()) walk(file);
			else result.push(Object.freeze({ path: file, mode: stat.mode & 0o177777,
				hash: sha256(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : stat.isFile() ? fs.readFileSync(absolute) : "[special file]") }));
		}
	};
	walk("");
	return Object.freeze(result);
}
export interface TrialBaseline {
	readonly initialCommit: string;
	readonly initialTree: string;
	readonly files: readonly FileStamp[];
}
export async function initializeTrial(cwd: string): Promise<TrialBaseline> {
	await checkedGit(["init", "--initial-branch=main"], cwd);
	await checkedGit(["add", "--all", "--force", "--", "."], cwd);
	await checkedGit(["-c", "user.name=Evaluation", "-c", "user.email=evaluation@example.invalid", "-c", "commit.gpgsign=false",
		"commit", "--no-verify", "-m", "fixture"], cwd);
	return Object.freeze({
		initialCommit: (await checkedGit(["rev-parse", "HEAD"], cwd)).trim(),
		initialTree: (await checkedGit(["rev-parse", "HEAD^{tree}"], cwd)).trim(),
		files: snapshot(cwd),
	});
}
const nulNames = (text: string) => text.split("\0").filter((name) => name !== "");
export async function checkIntegrity(cwd: string, baseline: TrialBaseline, allowlist: readonly string[]) {
	const changed = new Set<string>();
	const errors: string[] = [];
	const whitespace: Array<{ code: number; stdout: string; stderr: string }> = [];
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "evaluation-integrity-"));
	try {
		// A private index alone still reads the worker's info/attributes. Use a
		// separate Git directory with highest-priority, evaluator-owned attributes.
		// Read worker objects through an alternate; all new objects/indexes stay private.
		const gitDir = path.join(scratch, ".git");
		const trusted = { GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir, GIT_WORK_TREE: cwd,
			GIT_INDEX_FILE: path.join(gitDir, "index"), GIT_OBJECT_DIRECTORY: path.join(gitDir, "objects"),
			GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify((await checkedGit(["rev-parse", "--path-format=absolute", "--git-path", "objects"], cwd)).trim()),
			GIT_CONFIG_GLOBAL: path.join(scratch, "empty-config"), GIT_ATTR_NOSYSTEM: "1" };
		fs.writeFileSync(trusted.GIT_CONFIG_GLOBAL, "");
		const initialized = await git(["init", "--template=", "--initial-branch=main"], scratch, trusted);
		if (initialized.code) throw new Error(initialized.stderr);
		fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
		fs.writeFileSync(path.join(gitDir, "info/attributes"),
			"* whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff -text -filter -ident -working-tree-encoding\n");
		const workerIndex = (await checkedGit(["rev-parse", "--path-format=absolute", "--git-path", "index"], cwd)).trim();
		if (fs.existsSync(workerIndex)) fs.copyFileSync(workerIndex, trusted.GIT_INDEX_FILE);
		// Split indexes refer to a sibling sharedindex file, which must also be private.
		const sharedIndex = (await checkedGit(["rev-parse", "--shared-index-path"], cwd)).trim();
		if (sharedIndex) fs.copyFileSync(path.resolve(cwd, sharedIndex), path.join(gitDir, path.basename(sharedIndex)));
		const initial = new Map(baseline.files.map((f) => [f.path, f]));
		for (const current of snapshot(cwd)) {
			const prior = initial.get(current.path);
			if (!prior || prior.hash !== current.hash || prior.mode !== current.mode) changed.add(current.path);
			initial.delete(current.path);
		}
		for (const file of initial.keys()) changed.add(file);
		const tree = (await checkedGit(["rev-parse", `${baseline.initialCommit}^{tree}`], cwd)).trim();
		if (tree !== baseline.initialTree) throw new Error("Initial tree no longer matches recorded baseline");
		const head = (await checkedGit(["rev-parse", "--verify", "HEAD"], cwd)).trim();
		if ((await git(["merge-base", "--is-ancestor", baseline.initialCommit, head], cwd)).code)
			errors.push("HEAD history no longer descends from the immutable initial commit");
		// Include staged-only edits, committed edits, and deletions; never split filenames on newlines.
		for (const staged of [false, true]) {
			const args = ["diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : [])];
			for (const name of nulNames(await checkedGit([...args, "--name-only", "--no-renames", "-z", baseline.initialCommit, "--"], cwd))) changed.add(name);
			whitespace.push(await git([...args, "--text", "--check", baseline.initialCommit, "--"], cwd, trusted));
		}
		// A forbidden edit committed and subsequently reverted is still an out-of-scope worker change.
		const commits = (await checkedGit(["rev-list", `${baseline.initialCommit}..${head}`, "--"], cwd)).trim().split("\n").filter(Boolean);
		for (const commit of commits) {
			for (const name of nulNames(await checkedGit(["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", commit, "--"], cwd))) changed.add(name);
			whitespace.push(await git(["show", "--format=", "--no-ext-diff", "--no-textconv", "--text", "--check", commit, "--"], cwd, trusted));
		}
		// Enumerate ignored files explicitly as well as ordinary untracked files.
		for (const ignored of [false, true])
			for (const name of nulNames(await checkedGit(["ls-files", "--others", ...(ignored ? ["--ignored"] : []), "--exclude-standard", "-z", "--"], cwd))) changed.add(name);
		// A second, fresh index also defeats assume-unchanged/skip-worktree flags
		// and includes newly created/ignored allowed files without touching worker state.
		const disk = { ...trusted, GIT_INDEX_FILE: path.join(scratch, "disk-index") };
		for (const args of [["read-tree", baseline.initialCommit], ["add", "--all", "--force", "--", "."]]) {
			const result = await git(args, cwd, disk);
			if (result.code) throw new Error(result.stderr);
		}
		whitespace.push(await git(["diff", "--no-ext-diff", "--no-textconv", "--text", "--cached", "--check", baseline.initialCommit, "--"], cwd, disk));
	} catch (error) { errors.push(String(error)); }
	finally { fs.rmSync(scratch, { recursive: true, force: true }); }
	const files = [...changed].sort();
	const forbidden = files.filter((name) => !allowlist.includes(name));
	return { passed: !errors.length && !forbidden.length && whitespace.every((check) => check.code === 0),
		initialCommit: baseline.initialCommit, changed: files, forbidden, errors, whitespace };
}

export interface EvaluationUsage {
	input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number;
}
const zero = (): EvaluationUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
const additive = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const;
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
function usage(raw: unknown): EvaluationUsage {
	const result = zero();
	if (raw === undefined || raw === null) return result;
	if (!object(raw)) throw new TypeError("Invalid reported evaluation usage");
	for (const key of [...additive, "contextTokens"] as const) {
		const n = key === "cost" && object(raw.cost) ? raw.cost.total : key === "contextTokens" ? raw.contextTokens ?? raw.totalTokens : raw[key];
		if (n === undefined) continue;
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new TypeError(`Invalid reported evaluation usage: ${key}`);
		result[key] = n;
	}
	return result;
}
function add(a: EvaluationUsage, b: EvaluationUsage) {
	for (const key of additive) a[key] += b[key];
	a.contextTokens = Math.max(a.contextTokens, b.contextTokens);
	return a;
}
function maximum(a: EvaluationUsage, b: EvaluationUsage) {
	for (const key of [...additive, "contextTokens"] as const) a[key] = Math.max(a[key], b[key]);
	return a;
}
function subtract(a: EvaluationUsage, b: EvaluationUsage) {
	for (const key of additive) a[key] = Math.max(0, a[key] - b[key]);
	return a;
}
/**
 * Stock publishes descendant charges in details.results, not SDK tool usage. Reconstruct
 * those missing charges at each tool boundary. Never replace unrelated wrapper charges.
 * SDK totals are a floor, not another additive charge; managed extended totals already
 * include descendants (including interrupted/error runs) and are left untouched.
 */
export function normalizeTrialUsage(run: { usage?: unknown; messages?: unknown[]; attemptHistory?: Array<{ usage?: unknown; messages?: unknown[] }> }, variant: string) {
	const reported = usage(run.usage);
	const warnings = new Set<string>();
	if (variant !== "stock") return { reported, normalized: { ...reported }, addedStock: zero(), complete: true, warnings: [] as string[] };
	type Charge = { total: EvaluationUsage; covered: EvaluationUsage; opaqueManaged: boolean };
	type Evidence = Map<string, Charge>;
	const billing = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
	const merge = (into: Evidence, from: Evidence) => {
		for (const [id, charge] of from) {
			const prior = into.get(id);
			if (!prior) into.set(id, { total: { ...charge.total }, covered: { ...charge.covered }, opaqueManaged: charge.opaqueManaged });
			else {
				maximum(prior.total, charge.total);
				maximum(prior.covered, charge.covered);
				prior.opaqueManaged &&= charge.opaqueManaged;
			}
		}
		return into;
	};
	const entries = (evidence: Evidence) => [...evidence.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	const sum = (evidence: Evidence, key: "total" | "covered") => entries(evidence).reduce((total, [, charge]) => add(total, charge[key]), zero());
	const fingerprint = (value: unknown) => sha256(JSON.stringify(value, (_key, child) => object(child)
		? Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]])) : child));
	const reconcile = (raw: unknown, messages: unknown[], child = false): EvaluationUsage => {
		const sdkTotal = usage(raw);
		const { direct, observed } = messagesUsage(messages);
		if (billing.some((key) => observed[key] > direct[key] && sdkTotal[key] > direct[key]))
			warnings.add(`Ambiguous SDK ${child ? "child " : ""}totals may overlap stock descendant usage; totals retained as a floor, not an additional charge`);
		return maximum(sdkTotal, observed);
	};
	const messagesUsage = (messages: unknown[]) => {
		// Correlate calls within this transcript only, not copied attempts or child
		// transcripts. One returned child cannot prove usage for another omitted call.
		const calls = new Set<string>(), results = new Set<string>(), scanned = new Set<object>();
		const reference = (id: unknown) => {
			if (typeof id === "string" && id) calls.add(id);
			else warnings.add("Incomplete stock subagent call: missing call identity");
		};
		const scan = (value: unknown): void => {
			if (!value || typeof value !== "object" || scanned.has(value)) return;
			scanned.add(value);
			if (Array.isArray(value)) { value.forEach(scan); return; }
			const v = value as Record<string, any>;
			if (v.role === "assistant" && Array.isArray(v.content))
				for (const call of v.content) if (object(call) && call.type === "toolCall" && call.name === "subagent") reference(call.id);
			if (object(v.nestedCalls) && Array.isArray(v.nestedCalls.calls))
				for (const call of v.nestedCalls.calls) if (object(call) && call.name === "subagent") reference(call.id);
			if (v.toolName === "subagent" && typeof v.toolCallId === "string" && Array.isArray(v.details?.results)) results.add(v.toolCallId);
			if (v.toolCall?.name === "subagent") {
				reference(v.toolCall.id);
				if (typeof v.toolCall.id === "string" && Array.isArray(v.result?.details?.results)) results.add(v.toolCall.id);
			}
			for (const [key, child] of Object.entries(v))
				if (!["usage", "content", "messages", "attemptHistory", "arguments", "nestedCalls", "toolCall"].includes(key)) scan(child);
		};
		scan(messages);
		for (const id of calls) if (!results.has(id)) warnings.add(`Incomplete stock subagent call ${id}: no identity-matched results`);
		const direct = zero(), observed = zero();
		const seen = new Set<string>();
		for (const [index, raw] of messages.entries()) {
			if (!object(raw) || !["assistant", "toolResult"].includes(raw.role)) continue;
			const identity = raw.role === "toolResult" ? `tool:${raw.toolCallId ?? index}` : `assistant:${raw.subagentsExUsageEventId ?? index}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			const native = usage(raw.usage);
			if (raw.role === "assistant" && !(raw.stopReason === "aborted" && !raw.usage?.totalTokens)) native.turns = 1;
			add(direct, native);
			add(observed, native);
			if (raw.role !== "toolResult") continue;
			const evidence = stockDetails(raw, new Set());
			const covered = sum(evidence, "covered");
			// A nested SDK result is only coverage if its charge reached this message.
			if (billing.some((key) => covered[key] > native[key]))
				warnings.add("Incomplete SDK coverage: nested charges are not fully present in the outer tool usage");
			for (const key of additive) covered[key] = Math.min(covered[key], native[key]);
			for (const charge of evidence.values())
				if (charge.opaqueManaged && charge.total.cost > charge.covered.cost)
					warnings.add("Incomplete managed result: no transcript or SDK coverage proves descendant usage");
			add(observed, subtract(sum(evidence, "total"), covered));
		}
		return { direct, observed };
	};
	const stockDetails = (value: unknown, seen: Set<object>, index = 0, inResults = false): Evidence => {
		const found: Evidence = new Map();
		if (inResults && (!value || typeof value !== "object")) warnings.add("Incomplete stock result entry: usage is unknown");
		if (!value || typeof value !== "object" || seen.has(value)) return found;
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				for (const [i, item] of value.entries()) merge(found, stockDetails(item, seen, i, inResults));
				return found;
			}
			const v = value as Record<string, any>;
			const knownCost = object(v.usage) && (typeof v.usage.cost === "number" || (object(v.usage.cost) && typeof v.usage.cost.total === "number"));
			const opaqueManaged = typeof v.treeId === "string" && !Array.isArray(v.messages);
			if (inResults && (typeof v.agent !== "string" || (!Array.isArray(v.messages) && !opaqueManaged) || !knownCost))
				warnings.add("Incomplete/ambiguous stock details.results metadata: descendant usage may be missing");
			if (v.role === "toolResult" && v.toolName === "subagent" && (!object(v.details) || !Array.isArray(v.details.results)))
				warnings.add("Stock subagent result has no details.results; descendant usage is unknown");
			if (inResults && (knownCost || Array.isArray(v.messages))) {
				const id = typeof v.id === "string" ? v.id : `${index}:${fingerprint(v)}`;
				found.set(id, { total: reconcile(v.usage, Array.isArray(v.messages) ? v.messages : [], true), covered: zero(), opaqueManaged });
				return found;
			}
			for (const [key, child] of Object.entries(v)) {
				// Content is prose, never billing evidence; transcripts are reconciled above.
				if (["usage", "content", "messages", "attemptHistory"].includes(key)) continue;
				// SDK nestedCalls holds call metadata/arguments, never execution results.
				// Legacy wrapper arrays of explicit results are still traversed.
				if (key === "nestedCalls" && object(child)) continue;
				merge(found, stockDetails(child, seen, 0, key === "results"));
			}
			if (object(v.nestedCalls)) {
				if (v.nestedCalls.complete === false)
					warnings.add("Incomplete nestedCalls metadata: omitted calls may lack stock usage evidence");
				if (!found.size && Array.isArray(v.nestedCalls.calls) && v.nestedCalls.calls.some((call: unknown) => object(call) && call.name === "subagent"))
					warnings.add("Incomplete nestedCalls stock subagent evidence: call metadata has no reconstructable results or coverage");
			}
			// Collect coverage before deduplication, then union it by run identity.
			// An echo visited first must not consume the covered copy's evidence.
			// Generic wrappers can have unrelated fees; only explicit results cover details.
			if (v.usage && (v.toolName === "subagent" || (!v.role && v.details))) {
				const remaining = subtract(usage(v.usage), sum(found, "covered"));
				for (const [, charge] of entries(found))
					for (const key of additive) {
						const covered = Math.min(remaining[key], Math.max(0, charge.total[key] - charge.covered[key]));
						charge.covered[key] += covered;
						remaining[key] -= covered;
					}
			}
			return found;
		} finally { seen.delete(value); }
	};
	const reconstructed = zero();
	const attempts = run.attemptHistory?.length ? run.attemptHistory : [{ usage: run.usage, messages: run.messages }];
	for (const attempt of attempts) add(reconstructed, reconcile(attempt.usage, attempt.messages ?? []));
	const normalized = maximum({ ...reported }, reconstructed);
	return { reported, normalized, addedStock: subtract({ ...normalized }, reported), complete: warnings.size === 0, warnings: [...warnings] };
}

export function trialBudgets(variant: string, timeoutSeconds: number, maxCost: number) {
	return { root: { timeoutSeconds, maxTurns: 20, maxCost, retries: 0 },
		descendants: variant === "extended"
			? { enforcement: "shared-tree", concurrency: 4, maxRuns: 32, maxTurns: 100, maxCost }
			: { enforcement: variant === "stock" ? "stock implementation only; no shared descendant admission/turn/cost guard" : "not applicable" },
		costSemantics: "observed ceiling; in-flight requests may overshoot" };
}
/** Stable hashes include all case files, checks and references, not only the prompt. */
export function corpusDigest(corpus: string): string { return sha256(JSON.stringify(snapshot(corpus))); }
export function fileIdentity(file: string) { return { path: path.resolve(file), sha256: sha256(fs.readFileSync(file)) }; }
export function packageVersion(entry: string, name: string): string {
	for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
		const file = path.join(dir, "package.json");
		if (fs.existsSync(file)) { const pkg = JSON.parse(fs.readFileSync(file, "utf8")); if (pkg.name === name) return pkg.version; }
		if (path.dirname(dir) === dir) throw new Error(`Cannot locate ${name} package metadata`);
	}
}
