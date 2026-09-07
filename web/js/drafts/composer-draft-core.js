export function composerDraftKey(fields) {
  return JSON.stringify([
    fields.server || '',
    fields.device || '',
    fields.projectHash || '',
    fields.sessionId || '',
  ]);
}

export function createComposerDraftStore(backend, options) {
  options = options || {};
  var now = options.now || Date.now;

  async function get(fields) {
    return backend.get(composerDraftKey(fields));
  }

  async function put(fields, text) {
    var record = {
      key: composerDraftKey(fields),
      server: fields.server || '',
      device: fields.device || '',
      projectHash: fields.projectHash || '',
      sessionId: fields.sessionId || '',
      text: String(text || ''),
      updatedAt: now(),
    };
    await backend.put(record);
    return record;
  }

  function remove(fields) {
    return backend.delete(composerDraftKey(fields));
  }

  return {
    get: get,
    put: put,
    delete: remove,
  };
}

export function createComposerDraftController(store, options) {
  options = options || {};
  var readInput = options.readInput;
  var applyInput = options.applyInput;
  var schedule = options.schedule || setTimeout;
  var cancel = options.cancel || clearTimeout;
  var debounceMs = options.debounceMs == null ? 180 : options.debounceMs;
  var activeFields = null;
  var activeKey = '';
  var lastText = '';
  var timer = null;
  var generation = 0;
  var writeChain = Promise.resolve();

  function enqueue(operation) {
    var result = writeChain.then(operation);
    writeChain = result.catch(function () {});
    return result;
  }

  function persist(fields, text) {
    if (!fields || !fields.sessionId) return Promise.resolve();
    return enqueue(function () {
      return text ? store.put(fields, text) : store.delete(fields);
    });
  }

  function cancelScheduledWrite() {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function captureNow() {
    cancelScheduledWrite();
    if (!activeFields) return writeChain;
    var fields = activeFields;
    var text = String(readInput() || '');
    lastText = text;
    return persist(fields, text);
  }

  function sync() {
    if (!activeFields) return;
    var text = String(readInput() || '');
    if (text === lastText) return;
    lastText = text;
    cancelScheduledWrite();
    var fields = activeFields;
    timer = schedule(function () {
      timer = null;
      persist(fields, text);
    }, debounceMs);
  }

  async function activate(fields, activateOptions) {
    activateOptions = activateOptions || {};
    var restore = activateOptions.restore !== false;
    var previousSave = captureNow();
    var nextFields = Object.assign({}, fields);
    var nextKey = composerDraftKey(nextFields);
    var activation = ++generation;
    activeFields = nextFields;
    activeKey = nextKey;
    lastText = '';
    applyInput('');
    if (!restore || !nextFields.sessionId) return null;

    await previousSave.catch(function () {});
    var record = await store.get(nextFields).catch(function () { return null; });
    if (activation !== generation || activeKey !== nextKey) return null;
    if (lastText || String(readInput() || '')) return null;
    if (!record || !record.text) return null;
    lastText = record.text;
    applyInput(record.text);
    return record;
  }

  function clear() {
    cancelScheduledWrite();
    if (!activeFields) return Promise.resolve();
    lastText = '';
    return persist(activeFields, '');
  }

  function deactivate(deactivateOptions) {
    deactivateOptions = deactivateOptions || {};
    var saved = captureNow();
    generation++;
    activeFields = null;
    activeKey = '';
    lastText = '';
    if (deactivateOptions.clearInput !== false) applyInput('');
    return saved;
  }

  function rekey(fields) {
    cancelScheduledWrite();
    var oldFields = activeFields;
    var nextFields = Object.assign({}, fields);
    var nextKey = composerDraftKey(nextFields);
    var text = String(readInput() || '');
    generation++;
    activeFields = nextFields;
    activeKey = nextKey;
    lastText = text;
    return enqueue(async function () {
      if (oldFields && composerDraftKey(oldFields) !== nextKey) {
        await store.delete(oldFields);
      }
      if (text) await store.put(nextFields, text);
      else await store.delete(nextFields);
    });
  }

  return {
    activate: activate,
    clear: clear,
    deactivate: deactivate,
    flush: captureNow,
    rekey: rekey,
    sync: sync,
  };
}
