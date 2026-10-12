export async function mapLimit(items, limit, fn) {
  const result = [];
  await Promise.all(items.map(async (item, index) => result.push(await fn(item, index))));
  return result;
}
