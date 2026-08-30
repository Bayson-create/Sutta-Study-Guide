import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workerSource = fs.readFileSync(new URL('../docs/tipitaka-data-worker.js', import.meta.url), 'utf8');
const readerSource = fs.readFileSync(new URL('../docs/tipitaka-reader.js', import.meta.url), 'utf8');
let fetchCount = 0;
let deleted = 0;
const messages = [];
const cache = {
  async match() { return null; },
  async put() {},
  async delete() { deleted += 1; return true; },
};
const context = {
  Request,
  caches: { async open() { return cache; } },
  fetch: async () => {
    fetchCount += 1;
    return fetchCount === 1
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify({ format: 'tipitaka-commentary-links/v5', rows: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
  self: { postMessage(message) { messages.push(message); } },
};
vm.runInNewContext(workerSource, context, { filename: 'tipitaka-data-worker.js' });

await context.self.onmessage({ data: { id: 1, base: 'https://example.test/v5', path: 'fragments/test.json.gz' } });
assert.equal(messages.at(-1).ok, false);
assert.equal(messages.at(-1).status, 404);
await context.self.onmessage({ data: { id: 2, base: 'https://example.test/v5', path: 'fragments/test.json.gz', reload: true } });
assert.equal(messages.at(-1).ok, true);
assert.equal(fetchCount, 2, 'a rejected promise must not remain cached');
assert.equal(deleted, 1, 'forced retry must clear the Cache API entry');

const fragmentLoader = readerSource.slice(readerSource.indexOf('async function loadCommentaryAsset'), readerSource.indexOf('async function overrides'));
assert.match(fragmentLoader, /commentaryAsset\(format\)/);
assert.doesNotMatch(fragmentLoader, /COMMENTARY_V3_BASE/);
assert.match(readerSource, /manifest\.json[\s\S]+method: 'HEAD'/);
console.log('Tipiṭaka commentary loading regression checks passed.');
