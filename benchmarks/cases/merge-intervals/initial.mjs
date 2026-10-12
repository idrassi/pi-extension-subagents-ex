export function mergeIntervals(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  const result = [intervals[0]];
  for (const current of intervals.slice(1)) {
    const last = result.at(-1);
    if (current[0] < last[1]) last[1] = current[1];
    else result.push(current);
  }
  return result;
}
