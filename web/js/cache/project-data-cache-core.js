export const PROJECT_CACHE_MAX_RECORDS = 2048;
export const PROJECT_CACHE_EVICT_COUNT = 512;

export function projectCacheScope(fields) {
  return JSON.stringify([
    fields.server || '',
    fields.device || '',
    fields.projectHash || '',
  ]);
}

export function projectCacheKey(fields) {
  return JSON.stringify([
    fields.server || '',
    fields.device || '',
    fields.projectHash || '',
    fields.type || '',
    fields.path || '',
  ]);
}

export function isStorageQuotaError(error) {
  return !!error && (
    error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014
  );
}

export function createProjectDataCache(backend, options) {
  options = options || {};
  var maxRecords = options.maxRecords || PROJECT_CACHE_MAX_RECORDS;
  var evictCount = options.evictCount || PROJECT_CACHE_EVICT_COUNT;
  var now = options.now || Date.now;
  var schedule = options.schedule || function (task) { setTimeout(task, 0); };
  var knownCount = null;
  var cleanupPromise = null;
  var scheduledMaintenance = null;

  async function recordCount() {
    if (knownCount == null) knownCount = await backend.count();
    return knownCount;
  }

  async function cleanup(force) {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async function () {
      var count = await recordCount();
      var removed = 0;
      if (!force && count <= maxRecords) return removed;
      do {
        var limit = Math.min(evictCount, count);
        if (!limit) break;
        var deleted = await backend.deleteOldest(limit);
        removed += deleted;
        count -= deleted;
        knownCount = count;
        if (!deleted || force) break;
      } while (count > maxRecords);
      return removed;
    })().finally(function () {
      cleanupPromise = null;
    });
    return cleanupPromise;
  }

  function scheduleCleanup() {
    if (scheduledMaintenance) return scheduledMaintenance;
    scheduledMaintenance = new Promise(function (resolve, reject) {
      schedule(function () {
        cleanup(false).then(resolve, reject).finally(function () {
          scheduledMaintenance = null;
        });
      });
    });
    return scheduledMaintenance;
  }

  async function put(fields, data, metadata) {
    metadata = metadata || {};
    var timestamp = now();
    var record = {
      key: projectCacheKey(fields),
      projectScope: projectCacheScope(fields),
      server: fields.server || '',
      device: fields.device || '',
      projectHash: fields.projectHash || '',
      projectPath: fields.projectPath || '',
      type: fields.type || '',
      path: fields.path || '',
      data: data,
      scrollTop: Math.max(0, metadata.scrollTop || 0),
      updatedAt: timestamp,
      lastAccessAt: timestamp,
    };
    var result;
    try {
      result = await backend.put(record);
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error;
      await cleanup(true);
      result = await backend.put(record);
    }
    if (knownCount == null) knownCount = await backend.count();
    else if (result.inserted) knownCount++;
    if (knownCount > maxRecords) scheduleCleanup();
    return record;
  }

  async function get(fields) {
    var record = await backend.get(projectCacheKey(fields));
    if (!record) return null;
    record.lastAccessAt = now();
    try {
      await backend.put(record);
    } catch (error) {}
    return record;
  }

  async function remove(fields) {
    var deleted = await backend.delete(projectCacheKey(fields));
    if (deleted && knownCount != null) knownCount = Math.max(0, knownCount - 1);
    return deleted;
  }

  async function removeProject(fields) {
    var deleted = await backend.deleteProject(projectCacheScope(fields));
    if (knownCount != null) knownCount = Math.max(0, knownCount - deleted);
    return deleted;
  }

  async function clear() {
    await backend.clear();
    knownCount = 0;
  }

  async function flushMaintenance() {
    if (scheduledMaintenance) await scheduledMaintenance;
    if (cleanupPromise) await cleanupPromise;
  }

  return {
    get: get,
    put: put,
    delete: remove,
    deleteProject: removeProject,
    clear: clear,
    count: recordCount,
    cleanup: cleanup,
    flushMaintenance: flushMaintenance,
  };
}
