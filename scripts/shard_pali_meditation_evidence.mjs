#!/usr/bin/env node

/* Split the complete audited evidence array into GitHub-friendly gzip shards. */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const dir = resolve(root, 'docs/research/pali-meditation-evidence');
const input = JSON.parse(await readFile(resolve(dir, 'audited-evidence.json'), 'utf8'));
const chunkSize = 5000;
const files = [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
await mkdir(dir, { recursive: true });
for (let offset = 0, index = 1; offset < input.length; offset += chunkSize, index += 1) {
  const payload = Buffer.from(JSON.stringify(input.slice(offset, offset + chunkSize)), 'utf8');
  const compressed = gzipSync(payload, { level: 9 });
  const name = `audited-evidence-${String(index).padStart(3, '0')}.json.gz`;
  await writeFile(resolve(dir, name), compressed);
  files.push({ file: name, rows: Math.min(chunkSize, input.length - offset), bytes: compressed.length, sha256: sha256(compressed) });
}
await writeFile(resolve(dir, 'evidence-shards.json'), JSON.stringify({ format: 'v4-meditation-evidence-shards/v1', generated_at: new Date().toISOString(), total_rows: input.length, chunk_size: chunkSize, files }, null, 2));
console.log(JSON.stringify({ total_rows: input.length, shards: files.length, max_bytes: Math.max(...files.map(item => item.bytes)) }, null, 2));
