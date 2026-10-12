export function mergeIntervals(intervals) {
  const sorted = intervals.map((pair) => [...pair]).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const current of sorted) {
    const last = result.at(-1);
    if (last && current[0] <= last[1]) last[1] = Math.max(last[1], current[1]);
    else result.push(current);
  }
  return result;
}
