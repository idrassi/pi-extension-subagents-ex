export function renderReport(records, options) {
  const selected = records.filter((record) =>
    record.score >= options.minScore && (options.includeInactive || record.active));
  selected.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = selected.map((record) => record.name + ": " + record.score);
  return [options.title, ...(lines.length ? lines : ["(no matches)"])].join("\n") + "\n";
}
