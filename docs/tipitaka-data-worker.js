/* Decode and parse V4 work payloads away from the main thread. */
(() => {
  const workCache = new Map();
  async function load(base, path) {
    const key = `${base}/${path}`;
    if (!workCache.has(key)) {
      const promise = (async () => {
        const request = new Request(key, { mode: 'cors' });
        const cache = typeof caches !== 'undefined' ? await caches.open('tipitaka-reader-v2-data') : null;
        let response = cache ? await cache.match(request) : null;
        if (!response) {
          response = await fetch(request);
          // Reading remains available when the optional offline cache cannot
          // accept a response (for example because of a storage quota).
          if (cache && response.ok) await cache.put(request, response.clone()).catch(() => {});
        }
        if (!response.ok) throw new Error(`数据加载失败（${response.status}）`);
        return response.json();
      })();
      workCache.set(key, promise);
    }
    return workCache.get(key);
  }
  self.onmessage = async event => {
    const { id, base, path } = event.data || {};
    if (!id) return;
    try {
      const data = await load(base, path);
      self.postMessage({ id, ok: true, data });
    } catch (error) {
      self.postMessage({ id, ok: false, error: error.message || String(error) });
    }
  };
})();
