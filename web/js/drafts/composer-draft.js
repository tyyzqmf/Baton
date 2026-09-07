import { state } from '../state.js';
import {
  createComposerDraftController,
  createComposerDraftStore,
} from './composer-draft-core.js';
import {
  createIndexedDbComposerDraftBackend,
} from './composer-draft-idb.js';

const store = createComposerDraftStore(createIndexedDbComposerDraftBackend());
var initialized = false;

function inputElement() {
  return document.getElementById('msg-input');
}

function applyInput(text) {
  var input = inputElement();
  if (!input) return;
  input.value = text;
  input.style.height = 'auto';
  if (text) input.style.height = input.scrollHeight + 'px';
  var EventConstructor = input.ownerDocument?.defaultView?.Event || globalThis.Event;
  input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  if (typeof window.updateSendBtn === 'function') {
    window.updateSendBtn({ skipSpinner: true });
  }
}

function draftFields(sessionId) {
  return {
    server: state.SERVER || '',
    device: state.appState.device || '',
    projectHash: state.appState.project?.hash || '',
    sessionId: sessionId || '',
  };
}

const controller = createComposerDraftController(store, {
  readInput: function () {
    return inputElement()?.value || '';
  },
  applyInput: applyInput,
});

export function initComposerDrafts() {
  if (initialized) return;
  initialized = true;
  var input = inputElement();
  if (input) input.addEventListener('input', controller.sync);
  window.addEventListener('pagehide', controller.flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') controller.flush();
  });
}

export function activateComposerDraft(sessionId, options) {
  return controller.activate(draftFields(sessionId), options).catch(function () {
    return null;
  });
}

export function clearComposerDraft() {
  return controller.clear().catch(function () {});
}

export function deactivateComposerDraft(options) {
  return controller.deactivate(options).catch(function () {});
}

export function flushComposerDraft() {
  return controller.flush().catch(function () {});
}

export function rekeyComposerDraft(sessionId) {
  return controller.rekey(draftFields(sessionId)).catch(function () {});
}

export function syncComposerDraft() {
  controller.sync();
}
