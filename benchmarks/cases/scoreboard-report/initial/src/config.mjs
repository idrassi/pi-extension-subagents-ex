export function resolveConfig(fileConfig = {}, env = {}, flags = {}) {
  return {
    title: fileConfig.title || env.SCOREBOARD_TITLE || flags.title || "Scoreboard",
    minScore: fileConfig.minScore || Number(env.SCOREBOARD_MIN_SCORE) || flags.minScore || 0,
    includeInactive: fileConfig.includeInactive || Boolean(env.SCOREBOARD_INCLUDE_INACTIVE) || flags.includeInactive || false,
  };
}
