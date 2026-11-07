export function resolveConfig(fileConfig = {}, env = {}, flags = {}) {
  const choose = (key, envKey, fallback, parse = (value) => value) => {
    if (flags[key] !== undefined) return flags[key];
    if (env[envKey] !== undefined) return parse(env[envKey]);
    if (fileConfig[key] !== undefined) return fileConfig[key];
    return fallback;
  };
  const title = choose("title", "SCOREBOARD_TITLE", "Scoreboard");
  const minScore = choose("minScore", "SCOREBOARD_MIN_SCORE", 0, (value) => {
    if (typeof value !== "string" || value.trim() === "") throw new Error("Invalid score");
    return Number(value);
  });
  const includeInactive = choose("includeInactive", "SCOREBOARD_INCLUDE_INACTIVE", false, (value) => {
    if (value !== "true" && value !== "false") throw new Error("Invalid boolean");
    return value === "true";
  });
  if (typeof title !== "string") throw new Error("Invalid title");
  if (typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0) throw new Error("Invalid score");
  if (typeof includeInactive !== "boolean") throw new Error("Invalid boolean");
  return { title, minScore, includeInactive };
}
