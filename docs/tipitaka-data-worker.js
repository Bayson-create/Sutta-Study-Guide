/* Decode and parse V4 work payloads away from the main thread. */
(() => {
  const workCache = new Map();
  async function load(base, path) {
    const key = `${base}/${path}`;
    if (!workCache.has(key)) {
      const promise = fetch(key, { mode: 'cors' }).then(response => {
        if (!response.ok) throw new Error(`数据加载失败（${response.status}）`);
        return response.json();
      });
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
