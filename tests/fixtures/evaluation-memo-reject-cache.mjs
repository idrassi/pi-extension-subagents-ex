export function memoizeAsync(fn) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) {
      try { cache.set(key, Promise.resolve(fn(key))); }
      catch (error) { return Promise.reject(error); }
    }
    return cache.get(key);
  };
}
