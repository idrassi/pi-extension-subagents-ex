export function memoizeAsync(fn) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) {
      const pending = Promise.resolve().then(() => fn(key)).catch((error) => { cache.delete(key); throw error; });
      cache.set(key, pending);
    }
    return cache.get(key);
  };
}
