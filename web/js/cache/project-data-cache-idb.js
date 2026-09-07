const DEFAULT_DB_NAME = 'agentpeek-project-data-v1';
const STORE_NAME = 'project-data';
const DB_VERSION = 1;

function requestPromise(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

function transactionPromise(transaction) {
  return new Promise(function (resolve, reject) {
    transaction.oncomplete = function () { resolve(); };
    transaction.onabort = function () {
      reject(transaction.error || new Error('IndexedDB transaction aborted'));
    };
    transaction.onerror = function () {
      reject(transaction.error || new Error('IndexedDB transaction failed'));
    };
  });
}

export function openProjectDataDatabase(options) {
  options = options || {};
  var factory = options.indexedDB || globalThis.indexedDB;
  var dbName = options.dbName || DEFAULT_DB_NAME;
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));
  return new Promise(function (resolve, reject) {
    var request = factory.open(dbName, DB_VERSION);
    request.onupgradeneeded = function () {
      var db = request.result;
      var store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      if (!store.indexNames.contains('byLastAccess')) {
        store.createIndex('byLastAccess', 'lastAccessAt', { unique: false });
      }
      if (!store.indexNames.contains('byProject')) {
        store.createIndex('byProject', 'projectScope', { unique: false });
      }
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
    request.onblocked = function () {
      reject(new Error('IndexedDB upgrade blocked'));
    };
  });
}

export function createIndexedDbProjectCacheBackend(options) {
  options = options || {};
  var dbName = options.dbName || DEFAULT_DB_NAME;
  var factory = options.indexedDB || globalThis.indexedDB;
  var dbPromise = null;

  function database() {
    if (!dbPromise) {
      dbPromise = openProjectDataDatabase({
        indexedDB: factory,
        dbName: dbName,
      }).catch(function (error) {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  }

  async function withStore(mode, operation) {
    var db = await database();
    var transaction = db.transaction(STORE_NAME, mode);
    var store = transaction.objectStore(STORE_NAME);
    var result = await operation(store, transaction);
    await transactionPromise(transaction);
    return result;
  }

  async function get(key) {
    return withStore('readonly', function (store) {
      return requestPromise(store.get(key));
    });
  }

  async function put(record) {
    return withStore('readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var existingRequest = store.get(record.key);
        var inserted = false;
        existingRequest.onerror = function () { reject(existingRequest.error); };
        existingRequest.onsuccess = function () {
          inserted = existingRequest.result === undefined;
          var putRequest = store.put(record);
          putRequest.onerror = function () { reject(putRequest.error); };
          putRequest.onsuccess = function () { resolve({ inserted: inserted }); };
        };
      });
    });
  }

  async function remove(key) {
    return withStore('readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var existingRequest = store.getKey(key);
        existingRequest.onerror = function () { reject(existingRequest.error); };
        existingRequest.onsuccess = function () {
          if (existingRequest.result === undefined) {
            resolve(false);
            return;
          }
          var deleteRequest = store.delete(key);
          deleteRequest.onerror = function () { reject(deleteRequest.error); };
          deleteRequest.onsuccess = function () { resolve(true); };
        };
      });
    });
  }

  async function count() {
    return withStore('readonly', function (store) {
      return requestPromise(store.count());
    });
  }

  async function deleteOldest(limit) {
    return withStore('readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var deleted = 0;
        var request = store.index('byLastAccess').openCursor();
        request.onerror = function () { reject(request.error); };
        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor || deleted >= limit) {
            resolve(deleted);
            return;
          }
          var deleteRequest = cursor.delete();
          deleteRequest.onerror = function () { reject(deleteRequest.error); };
          deleteRequest.onsuccess = function () {
            deleted++;
            cursor.continue();
          };
        };
      });
    });
  }

  async function deleteProject(projectScope) {
    return withStore('readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var deleted = 0;
        var request = store.index('byProject').openCursor(IDBKeyRange.only(projectScope));
        request.onerror = function () { reject(request.error); };
        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor) {
            resolve(deleted);
            return;
          }
          var deleteRequest = cursor.delete();
          deleteRequest.onerror = function () { reject(deleteRequest.error); };
          deleteRequest.onsuccess = function () {
            deleted++;
            cursor.continue();
          };
        };
      });
    });
  }

  async function clear() {
    return withStore('readwrite', function (store) {
      return requestPromise(store.clear());
    });
  }

  async function close() {
    if (!dbPromise) return;
    var db = await dbPromise;
    db.close();
    dbPromise = null;
  }

  async function deleteDatabase() {
    await close();
    if (!factory) return;
    await requestPromise(factory.deleteDatabase(dbName));
  }

  return {
    get: get,
    put: put,
    delete: remove,
    count: count,
    deleteOldest: deleteOldest,
    deleteProject: deleteProject,
    clear: clear,
    close: close,
    deleteDatabase: deleteDatabase,
  };
}
