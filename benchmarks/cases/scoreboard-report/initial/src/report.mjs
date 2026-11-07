export function renderReport(records, options) {
  records.sort((a, b) => a.name < b.name ? -1 : 1);
  const lines = records.filter((record) => record.score > options.minScore)
    .map((record) => record.name + ": " + record.score);
  return options.title + "\n" + lines.join("\n");
}
