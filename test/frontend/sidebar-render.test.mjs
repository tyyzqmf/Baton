import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><aside id="sidebar"></aside><div id="content"></div></body>', {
  url: 'https://baton.test/index.html', pretendToBeVisual: true,
});
const w = dom.window;
for (const [key, value] of Object.entries({
  window: w, document: w.document, navigator: w.navigator,
  localStorage: w.localStorage, sessionStorage: w.sessionStorage,
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
w.matchMedia = media => ({ matches: true, media, addEventListener() {}, removeEventListener() {} });
w.api = () => new Promise(() => {});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
test.after(() => {
  globalThis.setInterval = realSetInterval;
  dom.window.close();
});

const at = '2026-11-18T01:00:00.000Z';
const session = (sessionId, status, projectHash) => ({
  sessionId, status, preview: sessionId + ' title', lastActive: at, deviceName: 'mac', projectHash, projectName: projectHash.slice(1),
});
const project = (deviceName, projectHash, sessions) => ({
  deviceName, projectHash, projectName: projectHash.slice(1), lastActive: at, sessions,
});

async function boot(name, active, devices) {
  localStorage.setItem('apeek_home_cache', JSON.stringify({ active, devices, cachedAt: Date.now() }));
  document.getElementById('sidebar').replaceChildren();
  await import(`../../web/js/sidebar.js?${name}`);
  return document.getElementById('sidebar');
}

const row = (root, sid) => root.querySelector(`.sidebar-thread[data-sid="${sid}"]`);
const projectRow = (root, hash) => [...root.querySelectorAll('.sidebar-project-toggle')]
  .find(button => JSON.parse(button.dataset.sidebarFold)[1] === hash);

test('threads show their runtime, status on the right, and projects their device and state', async () => {
  const waiting = session('codex:wait', 'needs_input', '-alpha');
  const runningClaude = session('run', 'running', '-alpha');
  const runningCodex = session('codex:busy', 'running', '-beta');
  const root = await boot('one-device', {
    sessions: [waiting, runningClaude, runningCodex],
    recentProjects: [
      project('mac', '-alpha', [runningClaude, waiting, session('done', 'completed', '-alpha')]),
      project('mac', '-beta', [runningCodex]),
      project('mac', '-gamma', [session('idle', 'completed', '-gamma')]),
    ],
  }, { devices: [{ deviceName: 'mac', deviceDisplayName: 'Office Mac', online: true }] });

  const claude = row(root, 'run');
  assert.ok(claude.querySelector('.runtime-mark:not(.runtime-mark-codex)'), 'Claude sessions use the Claude mark');
  assert.equal(claude.lastElementChild.className, 'sidebar-status running');
  assert.ok(row(root, 'codex:wait').querySelector('.runtime-mark.runtime-mark-codex'));
  assert.equal(row(root, 'codex:wait').lastElementChild.className, 'sidebar-status needs-input');
  assert.equal(row(root, 'done').querySelector('.sidebar-status'), null, 'finished sessions carry no glyph');
  assert.equal(root.querySelector('.sidebar-thread time'), null, 'rows no longer show times');

  const state = hash => projectRow(root, hash).querySelector('.sidebar-project-dot')?.className;
  assert.equal(state('-alpha'), 'sidebar-project-dot needs-input', 'waiting beats running');
  assert.equal(state('-beta'), 'sidebar-project-dot running');
  assert.equal(state('-gamma'), 'sidebar-project-dot online');
  assert.deepEqual([...root.querySelectorAll('.sidebar-project-device')].map(el => el.textContent),
    ['Office Mac', 'Office Mac', 'Office Mac'], 'the device shows even with one device');

  const toggle = projectRow(root, '-alpha');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.closest('.sidebar-project').querySelector('.sidebar-threads').hidden, true);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
});

test('a project on an offline device shows a hollow dot', async () => {
  const root = await boot('offline', {
    sessions: [], recentProjects: [project('mac', '-delta', [session('old', 'completed', '-delta')])],
  }, { devices: [{ deviceName: 'mac', online: false }] });
  assert.equal(projectRow(root, '-delta').querySelector('.sidebar-project-dot').className, 'sidebar-project-dot offline');
  assert.equal(projectRow(root, '-delta').querySelector('.sidebar-project-dot').getAttribute('aria-label'), 'Device offline');
});
