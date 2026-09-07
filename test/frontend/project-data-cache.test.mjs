import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectDataCache,
  PROJECT_CACHE_EVICT_COUNT,
  PROJECT_CACHE_MAX_RECORDS,
  projectCacheKey,
} from '../../web/js/cache/project-data-cache-core.js';
import fs from 'node:fs';

class MemoryBackend {
  constructor() {
    this.records = new Map();
    this.failNextPutWithQuota = false;
  }

  async get(key) {
    const value = this.records.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async put(record) {
    if (this.failNextPutWithQuota) {
      this.failNextPutWithQuota = false;
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    }
    const inserted = !this.records.has(record.key);
    this.records.set(record.key, structuredClone(record));
    return { inserted };
  }

  async delete(key) {
    return this.records.delete(key);
  }

  async count() {
    return this.records.size;
  }

  async deleteOldest(limit) {
    const oldest = [...this.records.values()]
      .sort((left, right) => left.lastAccessAt - right.lastAccessAt)
      .slice(0, limit);
    oldest.forEach((record) => this.records.delete(record.key));
    return oldest.length;
  }

  async deleteProject(projectScope) {
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.projectScope !== projectScope) continue;
      this.records.delete(key);
      deleted++;
    }
    return deleted;
  }

  async clear() {
    this.records.clear();
  }
}

function fields(projectHash, type = 'files', path = '') {
  return {
    server: 'https://server.test',
    device: 'Mac',
    projectHash,
    type,
    path,
  };
}

test('project cache inserts, reads, overwrites, and isolates composite keys', async () => {
  const backend = new MemoryBackend();
  let clock = 100;
  const cache = createProjectDataCache(backend, { now: () => ++clock });
  const root = fields('project-a');
  const src = fields('project-a', 'files', 'src');
  const git = fields('project-a', 'git');

  await cache.put(root, { entries: ['root'] }, { scrollTop: 12 });
  await cache.put(src, { entries: ['src'] });
  await cache.put(git, { groups: { changes: [] } });
  assert.equal(await cache.count(), 3);

  const rootRecord = await cache.get(root);
  assert.deepEqual(rootRecord.data, { entries: ['root'] });
  assert.equal(rootRecord.scrollTop, 12);
  assert.ok(rootRecord.lastAccessAt > rootRecord.updatedAt);

  await cache.put(root, { entries: ['updated'] }, { scrollTop: 25 });
  assert.equal(await cache.count(), 3);
  assert.deepEqual((await cache.get(root)).data, { entries: ['updated'] });
  assert.equal((await cache.get(root)).scrollTop, 25);
  assert.notEqual(projectCacheKey(root), projectCacheKey(src));
  assert.notEqual(projectCacheKey(root), projectCacheKey(git));
});

test('project cache deletes one record, one project, and all records', async () => {
  const backend = new MemoryBackend();
  const cache = createProjectDataCache(backend);
  const aRoot = fields('project-a');
  const aSrc = fields('project-a', 'files', 'src');
  const bRoot = fields('project-b');

  await cache.put(aRoot, {});
  await cache.put(aSrc, {});
  await cache.put(bRoot, {});
  assert.equal(await cache.delete(aSrc), true);
  assert.equal(await cache.delete(aSrc), false);
  assert.equal(await cache.deleteProject(fields('project-a')), 1);
  assert.equal(await cache.get(aRoot), null);
  assert.ok(await cache.get(bRoot));

  await cache.clear();
  assert.equal(await cache.count(), 0);
});

test('production LRU evicts exactly 512 oldest records after record 2049', async () => {
  assert.equal(PROJECT_CACHE_MAX_RECORDS, 2048);
  assert.equal(PROJECT_CACHE_EVICT_COUNT, 512);
  const backend = new MemoryBackend();
  let clock = 0;
  const cache = createProjectDataCache(backend, {
    now: () => ++clock,
    schedule: queueMicrotask,
  });

  for (let index = 0; index < 2049; index++) {
    await cache.put(fields('project', 'files', `dir-${index}`), { index });
  }
  await cache.flushMaintenance();

  assert.equal(await cache.count(), 1537);
  for (let index = 0; index < 512; index++) {
    assert.equal(await cache.get(fields('project', 'files', `dir-${index}`)), null);
  }
  assert.deepEqual(
    (await cache.get(fields('project', 'files', 'dir-512'))).data,
    { index: 512 },
  );
});

test('LRU reads refresh recency and quota failures evict then retry', async () => {
  const backend = new MemoryBackend();
  let clock = 0;
  const cache = createProjectDataCache(backend, {
    maxRecords: 4,
    evictCount: 2,
    now: () => ++clock,
    schedule: queueMicrotask,
  });
  for (let index = 0; index < 4; index++) {
    await cache.put(fields('project', 'files', `dir-${index}`), { index });
  }
  await cache.get(fields('project', 'files', 'dir-0'));
  await cache.put(fields('project', 'files', 'dir-4'), { index: 4 });
  await cache.flushMaintenance();
  assert.ok(await cache.get(fields('project', 'files', 'dir-0')));
  assert.equal(await cache.get(fields('project', 'files', 'dir-1')), null);
  assert.equal(await cache.get(fields('project', 'files', 'dir-2')), null);

  backend.failNextPutWithQuota = true;
  await cache.put(fields('project', 'files', 'after-quota'), { ok: true });
  assert.deepEqual(
    (await cache.get(fields('project', 'files', 'after-quota'))).data,
    { ok: true },
  );
});

test('Git, Project Files, project deletion, and credential clearing use the shared cache', () => {
  const git = fs.readFileSync(
    new URL('../../web/js/git/status.js', import.meta.url),
    'utf8',
  );
  const files = fs.readFileSync(
    new URL('../../web/js/project/browser.js', import.meta.url),
    'utf8',
  );
  const app = fs.readFileSync(
    new URL('../../web/js/app.js', import.meta.url),
    'utf8',
  );
  const api = fs.readFileSync(
    new URL('../../web/js/api.js', import.meta.url),
    'utf8',
  );
  assert.match(git, /readProjectDataCache/);
  assert.match(git, /writeProjectDataCache/);
  assert.match(git, /type: 'git'/);
  assert.match(files, /readProjectDataCache/);
  assert.match(files, /writeProjectDataCache/);
  assert.match(files, /type: 'files'/);
  assert.doesNotMatch(files, /DIRECTORY_CACHE_LIMIT/);
  assert.match(app, /await Promise\.all\(ids\.map\(function \(projectHash\) \{[\s\S]*?deleteProjectDataCache/);
  assert.match(api, /clearListCaches\(\);\s*clearProjectDataCache\(\);/);
});
