/* Decode and parse Tipiṭaka work and commentary payloads away from the main thread. */
(() => {
  const workCache = new Map();
  async function load(base, path, reload = false) {
    const key = `${base}/${path}`;
    if (reload) workCache.delete(key);
    if (!workCache.has(key)) {
      const promise = (async () => {
        const request = new Request(key, { mode: 'cors' });
        const cache = typeof caches !== 'undefined' ? await caches.open('tipitaka-reader-v2-data') : null;
        if (reload && cache) await cache.delete(request);
        let response = reload || !cache ? null : await cache.match(request);
        if (!response) {
          response = await fetch(request, reload ? { cache: 'reload' } : undefined);
          // Reading remains available when the optional offline cache cannot
          // accept a response (for example because of a storage quota).
          if (cache && response.ok) {
            try { await cache.put(request, response.clone()); } catch {}
          }
        }
        if (!response.ok) {
          const error = new Error(`数据加载失败（${response.status}）`);
          error.status = response.status;
          throw error;
        }
        return response.json();
      })();
      workCache.set(key, promise);
      promise.catch(() => { if (workCache.get(key) === promise) workCache.delete(key); });
    }
    return workCache.get(key);
  }
  self.onmessage = async event => {
    const { id, base, path, reload } = event.data || {};
    if (!id) return;
    try {
      const data = await load(base, path, reload === true);
      self.postMessage({ id, ok: true, data });
    } catch (error) {
      self.postMessage({ id, ok: false, error: error.message || String(error), status: error.status, path });
    }
  };
})();
