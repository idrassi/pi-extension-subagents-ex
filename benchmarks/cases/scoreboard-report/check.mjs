import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(process.env.EVAL_WORKSPACE, "EVAL_WORKSPACE is required");
const workspace = resolve(process.env.EVAL_WORKSPACE);
const { resolveConfig } = await import(pathToFileURL(resolve(workspace, "src/config.mjs")).href);
const { renderReport } = await import(pathToFileURL(resolve(workspace, "src/report.mjs")).href);
// All acceptance inputs and expected outputs live outside the evaluated workspace.
const protectedFiles = {
  "config/report.json": "{\n  \"title\": \"League standings\",\n  \"minScore\": 10,\n  \"includeInactive\": false\n}\n",
  "fixtures/players.json": "[\n  {\n    \"name\": \"Zoe\",\n    \"score\": 20,\n    \"active\": true\n  },\n  {\n    \"name\": \"Ada\",\n    \"score\": 20,\n    \"active\": true\n  },\n  {\n    \"name\": \"Retired\",\n    \"score\": 99,\n    \"active\": false\n  },\n  {\n    \"name\": \"Zero\",\n    \"score\": 0,\n    \"active\": true\n  },\n  {\n    \"name\": \"Ben\",\n    \"score\": 10,\n    \"active\": true\n  }\n]\n",
  "bin/report.mjs": "import { readFile } from \"node:fs/promises\";\nimport { resolveConfig } from \"../src/config.mjs\";\nimport { renderReport } from \"../src/report.mjs\";\n\nconst flags = {};\nlet configPath = new URL(\"../config/report.json\", import.meta.url);\nconst args = process.argv.slice(2);\nfor (let i = 0; i < args.length; i++) {\n  const flag = args[i];\n  if (flag === \"--include-inactive\") flags.includeInactive = true;\n  else if (flag === \"--exclude-inactive\") flags.includeInactive = false;\n  else if (flag === \"--title\" || flag === \"--min-score\" || flag === \"--config\") {\n    if (++i >= args.length) throw new Error(\"Missing value for \" + flag);\n    if (flag === \"--title\") flags.title = args[i];\n    else if (flag === \"--min-score\") flags.minScore = Number(args[i]);\n    else configPath = args[i];\n  } else throw new Error(\"Unknown option: \" + flag);\n}\nconst config = JSON.parse(await readFile(configPath, \"utf8\"));\nconst records = JSON.parse(await readFile(new URL(\"../fixtures/players.json\", import.meta.url), \"utf8\"));\nprocess.stdout.write(renderReport(records, resolveConfig(config, process.env, flags)));\n"
};
for (const [path, expected] of Object.entries(protectedFiles)) {
  assert.equal(await readFile(resolve(workspace, path), "utf8"), expected, path + " is protected");
}
const defaults = { title: "Scoreboard", minScore: 0, includeInactive: false };
assert.deepEqual(resolveConfig(), defaults);
assert.deepEqual(resolveConfig({ unrelated: true }, { UNRELATED: "yes" }, { extra: 3 }), defaults);
const file = Object.freeze({ title: "File", minScore: 12, includeInactive: true });
const env = Object.freeze({ SCOREBOARD_TITLE: "Environment", SCOREBOARD_MIN_SCORE: "7.5", SCOREBOARD_INCLUDE_INACTIVE: "false" });
const flags = Object.freeze({ title: "", minScore: 0, includeInactive: false });
assert.deepEqual(resolveConfig(file), file);
assert.deepEqual(resolveConfig(file, env), { title: "Environment", minScore: 7.5, includeInactive: false });
assert.deepEqual(resolveConfig(file, env, flags), flags);
assert.deepEqual(resolveConfig(file, {}, { minScore: 0 }), { ...file, minScore: 0 });
assert.deepEqual(resolveConfig({}, { SCOREBOARD_INCLUDE_INACTIVE: "true", SCOREBOARD_MIN_SCORE: "0", SCOREBOARD_TITLE: "" }), { ...defaults, title: "", includeInactive: true });
assert.deepEqual(resolveConfig(file, { SCOREBOARD_TITLE: "Env" }, { includeInactive: false }), { title: "Env", minScore: 12, includeInactive: false });
for (const minScore of [-1, NaN, Infinity, "2", null]) {
  assert.throws(() => resolveConfig({ minScore }));
  assert.throws(() => resolveConfig({}, {}, { minScore }));
}
for (const value of ["", "   ", "-1", "NaN", "Infinity", "abc"]) {
  assert.throws(() => resolveConfig({}, { SCOREBOARD_MIN_SCORE: value }));
}
for (const includeInactive of ["false", 0, 1, null]) {
  assert.throws(() => resolveConfig({ includeInactive }));
  assert.throws(() => resolveConfig({}, {}, { includeInactive }));
}
for (const value of ["yes", "False", "", "1"]) {
  assert.throws(() => resolveConfig({}, { SCOREBOARD_INCLUDE_INACTIVE: value }));
}
for (const title of [null, 1, false]) {
  assert.throws(() => resolveConfig({ title }));
  assert.throws(() => resolveConfig({}, {}, { title }));
}
// Invalid lower-precedence values are ignored when explicitly overridden.
assert.deepEqual(resolveConfig({ minScore: -1, includeInactive: "bad", title: 3 },
  { SCOREBOARD_MIN_SCORE: "bad", SCOREBOARD_INCLUDE_INACTIVE: "bad" }, flags), flags);

const records = Object.freeze([
  Object.freeze({ name: "Zoe", score: 20, active: true }),
  Object.freeze({ name: "Ada", score: 20, active: true }),
  Object.freeze({ name: "Retired", score: 99, active: false }),
  Object.freeze({ name: "Zero", score: 0, active: true }),
  Object.freeze({ name: "Ben", score: 10, active: true }),
]);
const options = Object.freeze({ title: "Test", minScore: 10, includeInactive: false });
assert.equal(renderReport(records, options), "Test\nAda: 20\nZoe: 20\nBen: 10\n");
assert.equal(renderReport(records, { ...options, includeInactive: true }), "Test\nRetired: 99\nAda: 20\nZoe: 20\nBen: 10\n");
assert.equal(renderReport(records, { ...options, title: "", minScore: 0 }), "\nAda: 20\nZoe: 20\nBen: 10\nZero: 0\n");
assert.equal(renderReport(records, { ...options, minScore: 100 }), "Test\n(no matches)\n");
assert.equal(renderReport([], options), "Test\n(no matches)\n");
assert.equal(renderReport([
  { name: "ten", score: 10, active: true }, { name: "two", score: 2, active: true },
  { name: "a", score: 2, active: true }, { name: "A", score: 2, active: true },
], { ...options, minScore: 2 }), "Test\nten: 10\nA: 2\na: 2\ntwo: 2\n");

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("SCOREBOARD_")) delete cleanEnv[key];
const cli = (args = [], extraEnv = {}) => execFileSync(process.execPath, ["bin/report.mjs", ...args], {
  cwd: workspace, env: { ...cleanEnv, ...extraEnv }, encoding: "utf8", timeout: 3000,
});
assert.equal(cli(), "League standings\nAda: 20\nZoe: 20\nBen: 10\n");
assert.equal(cli(["--title", "", "--min-score", "0", "--exclude-inactive"], {
  SCOREBOARD_TITLE: "Ignored", SCOREBOARD_MIN_SCORE: "90", SCOREBOARD_INCLUDE_INACTIVE: "true",
}), "\nAda: 20\nZoe: 20\nBen: 10\nZero: 0\n");
assert.equal(cli([], { SCOREBOARD_TITLE: "All", SCOREBOARD_MIN_SCORE: "99", SCOREBOARD_INCLUDE_INACTIVE: "true" }),
  "All\nRetired: 99\n");
assert.equal(cli(["--include-inactive", "--min-score", "20"]), "League standings\nRetired: 99\nAda: 20\nZoe: 20\n");
const invalid = spawnSync(process.execPath, ["bin/report.mjs", "--min-score", "-1"], {
  cwd: workspace, env: cleanEnv, encoding: "utf8", timeout: 3000,
});
assert.equal(invalid.error, undefined);
assert.notEqual(invalid.status, 0, "CLI must reject invalid effective configuration");
