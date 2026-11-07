import { readFile } from "node:fs/promises";
import { resolveConfig } from "../src/config.mjs";
import { renderReport } from "../src/report.mjs";

const flags = {};
let configPath = new URL("../config/report.json", import.meta.url);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--include-inactive") flags.includeInactive = true;
  else if (flag === "--exclude-inactive") flags.includeInactive = false;
  else if (flag === "--title" || flag === "--min-score" || flag === "--config") {
    if (++i >= args.length) throw new Error("Missing value for " + flag);
    if (flag === "--title") flags.title = args[i];
    else if (flag === "--min-score") flags.minScore = Number(args[i]);
    else configPath = args[i];
  } else throw new Error("Unknown option: " + flag);
}
const config = JSON.parse(await readFile(configPath, "utf8"));
const records = JSON.parse(await readFile(new URL("../fixtures/players.json", import.meta.url), "utf8"));
process.stdout.write(renderReport(records, resolveConfig(config, process.env, flags)));
