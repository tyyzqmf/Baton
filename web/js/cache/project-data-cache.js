import {
  createProjectDataCache,
  PROJECT_CACHE_EVICT_COUNT,
  PROJECT_CACHE_MAX_RECORDS,
} from './project-data-cache-core.js';
import {
  createIndexedDbProjectCacheBackend,
} from './project-data-cache-idb.js';

const backend = createIndexedDbProjectCacheBackend();
const cache = createProjectDataCache(backend);

export {
  PROJECT_CACHE_EVICT_COUNT,
  PROJECT_CACHE_MAX_RECORDS,
};

export function readProjectDataCache(fields) {
  return cache.get(fields).catch(function () { return null; });
}

export function writeProjectDataCache(fields, data, metadata) {
  return cache.put(fields, data, metadata).catch(function () { return null; });
}

export function deleteProjectDataCacheRecord(fields) {
  return cache.delete(fields).catch(function () { return false; });
}

export function deleteProjectDataCache(fields) {
  return cache.deleteProject(fields).catch(function () { return 0; });
}

export function clearProjectDataCache() {
  return cache.clear().catch(function () {});
}

export function flushProjectDataCacheMaintenance() {
  return cache.flushMaintenance().catch(function () {});
}
