const DEFAULT_DB_NAME = 'agentpeek-composer-drafts-v1';
const STORE_NAME = 'drafts';
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

export function openComposerDraftDatabase(options) {
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
      if (!store.indexNames.contains('bySession')) {
        store.createIndex('bySession', 'sessionId', { unique: false });
      }
      if (!store.indexNames.contains('byUpdatedAt')) {
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
    request.onblocked = function () {
      reject(new Error('IndexedDB upgrade blocked'));
    };
  });
}

export function createIndexedDbComposerDraftBackend(options) {
  options = options || {};
  var dbName = options.dbName || DEFAULT_DB_NAME;
  var factory = options.indexedDB || globalThis.indexedDB;
  var dbPromise = null;

  function database() {
    if (!dbPromise) {
      dbPromise = openComposerDraftDatabase({
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
    var result = await operation(transaction.objectStore(STORE_NAME));
    await transactionPromise(transaction);
    return result;
  }

  return {
    get: function (key) {
      return withStore('readonly', function (store) {
        return requestPromise(store.get(key));
      });
    },
    put: function (record) {
      return withStore('readwrite', function (store) {
        return requestPromise(store.put(record));
      });
    },
    delete: function (key) {
      return withStore('readwrite', function (store) {
        return requestPromise(store.delete(key));
      });
    },
  };
}
