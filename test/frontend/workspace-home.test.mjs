import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createWorkspaceHome, HOME_UI_KEY, sessionRow } from '../../web/js/workspace-home.js';
import { clearListCaches } from '../../web/js/list-cache.js';

const devices = { devices: [
  { deviceName: 'mac', deviceDisplayName: 'Office Mac', online: true, os: 'darwin', projectCount: 2 },
  { deviceName: 'linux', deviceDisplayName: 'Server', online: false, os: 'linux', projectCount: 1 },
] };
const session = (id, overrides = {}) => ({
  sessionId: id, deviceName: 'mac', projectHash: 'baton', projectName: 'Baton',
  preview: 'Session ' + id, status: 'running', lastActive: '2026-09-16T02:00:00Z', ...overrides,
});
const active = {
  sessions: [session('codex:one'), session('two', { status: 'needs_input', agentDetail: 'Approve access' })],
  recentSessions: Array.from({ length: 20 }, (_, i) => session('done-' + i, { status: undefined, deviceName: i % 2 ? 'linux' : 'mac' })),
};
const project = (hash = 'baton') => ({
  projectHash: hash, projectName: 'Baton', projectPath: '/work/' + hash,
  sessionCount: 9, runningCount: 1, needsInputCount: 1, lastActive: '2026-09-16T02:00:00Z',
});
const group = (device = 'mac', hash = 'baton', count = 9, overrides = {}) => ({
  ...project(hash), deviceName: device, deviceDisplayName: device === 'mac' ? 'Office Mac' : 'Server',
  sessionCount: count,
  sessionPage: {
    sessions: Array.from({ length: Math.min(5, count) }, (_, i) => session(`${device}-first${i}`)),
    hasMore: count > 5, nextCursor: count > 5 ? 'opaque-cursor' : null,
  },
  ...overrides,
});
const overview = (groups = [group('mac'), group('linux')]) => ({ projects: groups, hasMore: false, nextCursor: null });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const pointer = (h, target, type, overrides = {}) => target.dispatchEvent(new h.dom.window.PointerEvent(type, {
  bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, ...overrides,
}));

function harness(request = async () => ({ projects: [], hasMore: false }), saved, stored = {}) {
  const dom = new JSDOM('<body class="workspace-home"><div id="content"></div></body>', { url: 'https://test/index.html', pretendToBeVisual: true });
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
  Object.entries(stored).forEach(([key, value]) => dom.window.localStorage.setItem(key, value));
  if (saved) dom.window.sessionStorage.setItem(HOME_UI_KEY, JSON.stringify(saved));
  const workspace = createWorkspaceHome({ window: dom.window, request });
  const doc = dom.window.document;
  const click = (action, value) => {
    const element = [...doc.querySelectorAll('[data-wh]')].find(el => el.dataset.wh === action && (value === undefined || el.dataset.value === value));
    assert.ok(element, `Missing control: ${action} ${value}`);
    element.click();
  };
  workspace.render(active, devices);
  return {
    dom, doc, workspace, click,
    snapshot() {
      return {
        saved: JSON.parse(dom.window.sessionStorage.getItem(HOME_UI_KEY)),
        stored: Object.fromEntries(Object.keys(dom.window.localStorage).map(key => [key, dom.window.localStorage.getItem(key)])),
      };
    },
    close() {
      workspace.dispose();
      dom.window.close();
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
      else delete globalThis.localStorage;
    },
  };
}

test('project data and expanded sessions render from persistent cache before the overview response', async () => {
  const key = JSON.stringify(['mac', 'baton']);
  let h = harness(async () => overview([group('mac', 'baton', 1), group('offline', 'baton', 1), group('missing', 'empty', 0)]));
  try {
    h.click('mode', 'project');
    await tick();
    h.click('project', key);
    h.click('project', JSON.stringify(['offline', 'baton']));
    h.doc.getElementById('content').scrollTop = 400;
    h.doc.getElementById('content').dispatchEvent(new h.dom.window.Event('scroll'));
    const snapshot = h.snapshot();
    h.close();
    let resolve;
    const calls = [];
    h = harness((path, params) => {
      calls.push({ path, params });
      return new Promise(done => { resolve = done; });
    }, snapshot.saved, snapshot.stored);
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 3);
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open .wh-session').length, 2);
    assert.equal(h.doc.getElementById('content').scrollTop, 400);
    assert.deepEqual(calls, [{ path: '/api/bridge/project-sessions', params: { limit: 50 } }]);
    resolve(overview([group('mac', 'baton', 1, {
      projectPath: '/updated/Baton',
      sessionPage: { sessions: [session('mac-first0', { status: 'completed', preview: 'Updated title' })], hasMore: false, nextCursor: null },
    }), group('offline', 'baton', 1), group('missing', 'empty', 0)]));
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 3);
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open .wh-session').length, 2);
    const row = h.doc.querySelector('[data-device=mac].wh-session');
    assert.equal(row.querySelector('.wh-status').textContent, 'Done');
    assert.equal(row.querySelector('.wh-row-title').textContent, 'Updated title');
    assert.equal(h.doc.getElementById('content').scrollTop, 400);
    assert.equal(calls.length, 1);
    const updated = h.snapshot();
    h.close();
    h = harness(() => new Promise(() => {}), updated.saved, updated.stored);
    assert.equal(h.doc.querySelector('[data-device=mac].wh-session .wh-row-title').textContent, 'Updated title');
  } finally { h.close(); }
});

test('background project refresh preserves a pressed session through pointerup and click', async () => {
  let resolve;
  let refresh = false;
  const h = harness(() => refresh ? new Promise(done => { resolve = done; }) : Promise.resolve(overview([group('mac', 'baton', 1)])));
  try {
    h.click('mode', 'project');
    await tick();
    h.click('project', JSON.stringify(['mac', 'baton']));
    refresh = true;
    h.workspace.render(active, devices);
    const row = h.doc.querySelector('.wh-session');
    pointer(h, row, 'pointerdown');
    resolve(overview([group('mac', 'baton', 1, {
      sessionPage: { sessions: [session('mac-first0', { preview: 'Fresh title' })], hasMore: false, nextCursor: null },
    })]));
    await tick();
    assert.equal(row.isConnected, true, 'API completion must not remove the pressed link');
    assert.notEqual(row.querySelector('.wh-row-title').textContent, 'Fresh title');
    pointer(h, row, 'pointerup');
    await tick();
    assert.equal(row.isConnected, true, 'keep the link until the subsequent click is delivered');
    let clicked = false;
    h.doc.getElementById('content').addEventListener('click', event => {
      event.preventDefault();
      clicked = event.target.closest('.wh-session') === row;
    }, { once: true });
    row.click();
    assert.equal(clicked, true);
    await tick();
    assert.equal(h.doc.querySelector('.wh-row-title').textContent, 'Fresh title');
  } finally { h.close(); }
});

test('a deferred refresh cannot overwrite navigation triggered by the protected click', async () => {
  const h = harness();
  try {
    const row = h.doc.querySelector('.wh-session');
    pointer(h, row, 'pointerdown', { pointerType: 'touch' });
    h.workspace.render({ sessions: [session('fresh')], recentSessions: [] }, devices);
    assert.equal(row.isConnected, true);
    h.doc.getElementById('content').addEventListener('click', event => {
      event.preventDefault();
      h.doc.body.classList.remove('workspace-home');
      h.doc.getElementById('content').innerHTML = '<div class="next-page">Destination</div>';
    }, { once: true });
    pointer(h, row, 'pointerup', { pointerType: 'touch' });
    row.click();
    await tick();
    assert.equal(h.doc.querySelector('.next-page').textContent, 'Destination');
    assert.equal(h.doc.querySelector('.wh-workspace'), null);
  } finally { h.close(); }
});

test('pointer cancellation and window blur release deferred home paints', async () => {
  for (const end of ['pointercancel', 'blur']) {
    const h = harness();
    try {
      const row = h.doc.querySelector('.wh-session');
      pointer(h, row, 'pointerdown', { pointerType: 'touch' });
      h.workspace.render({ sessions: [session('fresh')], recentSessions: [] }, devices);
      assert.equal(row.isConnected, true);
      if (end === 'blur') h.dom.window.dispatchEvent(new h.dom.window.Event('blur'));
      else pointer(h, row, end, { pointerType: 'touch' });
      await tick();
      assert.equal(h.doc.querySelector('.wh-session').dataset.sid, 'fresh');
    } finally { h.close(); }
  }
});

test('disposed workspaces do not flush a queued pointer-protected paint', async () => {
  const h = harness();
  try {
    const row = h.doc.querySelector('.wh-session');
    pointer(h, row, 'pointerdown');
    h.workspace.render({ sessions: [session('fresh')], recentSessions: [] }, devices);
    assert.equal(row.isConnected, true);
    pointer(h, row, 'pointerup');
    h.workspace.dispose();
    await tick();
    assert.equal(row.isConnected, true);
  } finally { h.close(); }
});

test('a protected tab click applies its action immediately instead of replaying a deferred old view', async () => {
  const h = harness();
  try {
    const tab = h.doc.querySelector('[data-wh=mode][data-value=device]');
    pointer(h, tab, 'pointerdown');
    h.workspace.render({ sessions: [session('fresh')], recentSessions: [] }, devices);
    assert.equal(tab.isConnected, true);
    pointer(h, tab, 'pointerup');
    tab.click();
    assert.equal(h.doc.querySelector('.file-tab.active').dataset.value, 'device');
    await tick();
    assert.equal(h.doc.querySelector('.file-tab.active').dataset.value, 'device');
    assert.equal(h.doc.querySelector('.wh-session'), null);
  } finally { h.close(); }
});

test('pointerup without a click eventually releases a deferred refresh', async () => {
  const h = harness();
  try {
    const row = h.doc.querySelector('.wh-session');
    pointer(h, row, 'pointerdown');
    h.workspace.render({ sessions: [session('fresh')], recentSessions: [] }, devices);
    pointer(h, h.doc.body, 'pointerup');
    assert.equal(row.isConnected, true);
    await new Promise(resolve => h.dom.window.setTimeout(resolve, 550));
    assert.equal(h.doc.querySelector('.wh-session').dataset.sid, 'fresh');
  } finally { h.close(); }
});

test('cached catalog pages remain visible while revalidation rebuilds the pagination cursor', async () => {
  const groups = Array.from({ length: 51 }, (_, i) => group('mac', 'dir-' + i, 1));
  let h = harness(async (_path, params) => ({
    projects: params.cursor ? groups.slice(50) : groups.slice(0, 50),
    hasMore: !params.cursor, nextCursor: params.cursor ? null : 'old-next',
  }));
  try {
    h.click('mode', 'project');
    await tick();
    h.click('more-projects');
    await tick();
    h.click('project', JSON.stringify(['mac', 'dir-50']));
    const snapshot = h.snapshot();
    h.close();
    const pending = [];
    h = harness((path, params) => new Promise(resolve => pending.push({ path, params, resolve })), snapshot.saved, snapshot.stored);
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 51);
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 1);
    pending[0].resolve({ projects: groups.slice(0, 50), hasMore: true, nextCursor: 'fresh-next' });
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 51, 'page one must not discard the cached second page');
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 1);
    assert.equal(pending.length, 2);
    assert.equal(pending[1].params.cursor, 'fresh-next');
    pending[1].resolve({ projects: groups.slice(50), hasMore: true, nextCursor: 'fresh-third' });
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 51);
    h.click('more-projects');
    assert.equal(pending[2].params.cursor, 'fresh-third');
    pending[2].resolve(overview([group('linux', 'dir-50', 1)]));
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 52);
    assert.equal(h.doc.querySelector('[data-wh=more-projects]'), null);
  } finally { h.close(); }
});

test('cached exhausted session pages stay visible while fresh previews and tail pages merge', async () => {
  const key = JSON.stringify(['mac', 'baton']);
  const tail = { sessions: Array.from({ length: 4 }, (_, i) => session('tail-' + i)), hasMore: false, nextCursor: null };
  let h = harness(async path => path.endsWith('/project-sessions') ? overview([group()]) : tail);
  try {
    h.click('mode', 'project');
    await tick();
    h.click('project', key);
    h.click('more-sessions');
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 9);
    const snapshot = h.snapshot();
    h.close();
    const pending = [];
    h = harness((path, params) => new Promise(resolve => pending.push({ path, params, resolve })), snapshot.saved, snapshot.stored);
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 9);
    const fresh = group();
    fresh.sessionPage.sessions[0].preview = 'Updated preview';
    fresh.sessionPage.nextCursor = 'fresh-session-next';
    pending[0].resolve(overview([fresh]));
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 9, 'a preloaded preview must not shrink an exhausted cached list');
    assert.equal(h.doc.querySelector('[data-sid=mac-first0] .wh-row-title').textContent, 'Updated preview');
    assert.equal(pending.length, 2);
    assert.equal(pending[1].params.cursor, 'fresh-session-next');
    pending[1].resolve(tail);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 9);
    assert.equal(h.doc.querySelector('[data-wh=more-sessions]'), null);
    assert.equal(h.snapshot().saved.sessionPages[key], 2);
  } finally { h.close(); }
});

test('failed cache revalidation retains rows and storage; retry reconciles an authoritative empty response', async () => {
  let h = harness(async () => overview([group('mac', 'baton', 1)]));
  try {
    h.click('mode', 'project');
    await tick();
    h.click('project', JSON.stringify(['mac', 'baton']));
    const snapshot = h.snapshot();
    h.close();
    let fail = true;
    h = harness(async () => {
      if (fail) throw new Error('offline');
      return overview([]);
    }, snapshot.saved, snapshot.stored);
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 1);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 1);
    assert.match(h.doc.querySelector('[role=alert]').textContent, /已保留现有内容/);
    assert.deepEqual(h.snapshot().stored, snapshot.stored);
    fail = false;
    h.click('more-projects');
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 0);
    assert.match(h.doc.querySelector('.empty').textContent, /暂无项目/);
    const empty = h.snapshot();
    h.close();
    h = harness(() => new Promise(() => {}), empty.saved, empty.stored);
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 0);
    assert.match(h.doc.body.textContent, /暂无项目/);
  } finally { h.close(); }
});

test('cached pagination retries from the fresh cursor after a tail refresh fails', async () => {
  const key = JSON.stringify(['mac', 'baton']);
  const tail = { sessions: [session('tail')], hasMore: true, nextCursor: 'old-third' };
  let h = harness(async path => path.endsWith('/project-sessions') ? overview([group()]) : tail);
  try {
    h.click('mode', 'project');
    await tick();
    h.click('project', key);
    h.click('more-sessions');
    await tick();
    const snapshot = h.snapshot();
    h.close();
    const calls = [];
    let fail = true;
    h = harness(async (path, params) => {
      calls.push({ path, params });
      if (path.endsWith('/project-sessions')) return overview([group()]);
      if (fail) throw new Error('offline');
      return { ...tail, nextCursor: 'fresh-third' };
    }, snapshot.saved, snapshot.stored);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 6);
    assert.ok(h.doc.querySelector('[role=alert]'));
    fail = false;
    h.click('more-sessions', key);
    await tick();
    assert.equal(calls.at(-1).params.cursor, 'opaque-cursor', 'retry must not skip to the old cached tail cursor');
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 6);
    h.click('more-sessions', key);
    await tick();
    assert.equal(calls.at(-1).params.cursor, 'fresh-third');
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 6, 'overlapping pages deduplicate session IDs');
  } finally { h.close(); }
});

test('project caching is lazy for status view and follows existing account cache cleanup', async () => {
  let h = harness(async () => overview([group('mac', 'baton', 1)]));
  try {
    h.click('mode', 'project');
    await tick();
    const snapshot = h.snapshot();
    assert.ok(Object.keys(snapshot.stored).some(key => key.startsWith('apeek_list_cache_v2:')));
    h.close();
    const calls = [];
    h = harness(path => {
      calls.push(path);
      return new Promise(() => {});
    }, { ...snapshot.saved, mode: 'status' }, snapshot.stored);
    assert.deepEqual(calls, []);
    h.click('mode', 'project');
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 1);
    assert.deepEqual(calls, ['/api/bridge/project-sessions']);
    clearListCaches();
    const cleared = h.snapshot();
    assert.deepEqual(cleared.stored, {});
    h.close();
    h = harness(() => new Promise(() => {}), cleared.saved, cleared.stored);
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 0);
  } finally { h.close(); }
});

test('logout or account changes prevent a late overview from repopulating persistent cache', async () => {
  for (const field of ['_ak', '_as']) {
    let resolve;
    const h = harness(() => new Promise(done => { resolve = done; }));
    try {
      h.click('mode', 'project');
      h.dom.window.localStorage.setItem(field, 'changed-fixture');
      clearListCaches();
      resolve(overview([group()]));
      await tick();
      assert.equal(h.doc.querySelector('.wh-project-group'), null);
      assert.equal(Object.keys(h.snapshot().stored).filter(key => key.includes('cache')).length, 0);
    } finally { h.close(); }
  }
});

test('account isolation starts on first render after startup credentials are available', () => {
  const dom = new JSDOM('<body class="workspace-home"><div id="content"></div></body>', { url: 'https://test/index.html' });
  const workspace = createWorkspaceHome({ window: dom.window, request: () => new Promise(() => {}) });
  try {
    dom.window.localStorage.setItem('_ak', dom.window.btoa('startup-fixture'));
    workspace.render(active, devices);
    assert.equal(dom.window.document.querySelectorAll('#wh-active .wh-session').length, 2);
  } finally { workspace.dispose(); dom.window.close(); }
});

test('invalid snapshots fall back to the API without importing transient loading flags', async () => {
  let h = harness(async () => overview([group('mac', 'baton', 1)]));
  let snapshot;
  try {
    h.click('mode', 'project');
    await tick();
    snapshot = h.snapshot();
  } finally { h.close(); }
  const cacheKey = Object.keys(snapshot.stored)[0];
  const payload = JSON.parse(snapshot.stored[cacheKey]);
  const badSession = structuredClone(payload);
  badSession.sessions[JSON.stringify(['mac', 'baton'])].items = [null];
  for (const invalid of ['{broken', 'null', JSON.stringify({ schema: 0 }), JSON.stringify(badSession)]) {
    let resolve;
    h = harness(() => new Promise(done => { resolve = done; }), snapshot.saved, { [cacheKey]: invalid });
    try {
      assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 0);
      resolve(overview([group('linux', 'valid', 1)]));
      await tick();
      assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 1);
      assert.equal(h.doc.querySelector('[role=alert]'), null);
    } finally { h.close(); }
  }
  payload.catalog.loading = true;
  payload.catalog.requestId = 999;
  let calls = 0;
  h = harness(() => { calls++; return new Promise(() => {}); }, snapshot.saved, { [cacheKey]: JSON.stringify(payload) });
  try {
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 1);
    assert.equal(calls, 1);
  } finally { h.close(); }
});

test('unavailable or full local storage does not block successful project rendering', async () => {
  for (const name of ['SecurityError', 'QuotaExceededError']) {
    const h = harness(async () => overview([group('mac', 'baton', 1)]));
    const prototype = Object.getPrototypeOf(h.dom.window.localStorage);
    const originalGet = prototype.getItem;
    const originalSet = prototype.setItem;
    const fail = () => { throw Object.assign(new Error('fixture storage unavailable'), { name }); };
    try {
      prototype.setItem = function (key, value) {
        if (key.startsWith('apeek_list_cache')) fail();
        return originalSet.call(this, key, value);
      };
      if (name === 'SecurityError') prototype.getItem = function (key) {
        if (key.startsWith('apeek_list_cache')) fail();
        return originalGet.call(this, key);
      };
      h.click('mode', 'project');
      await tick();
      assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 1);
      assert.equal(h.doc.querySelector('[role=alert]'), null);
    } finally {
      prototype.getItem = originalGet;
      prototype.setItem = originalSet;
      h.close();
    }
  }
});

test('home defaults to status with three compact tabs, no device filter and the global recent-20 boundary', () => {
  const h = harness();
  try {
    assert.deepEqual([...h.doc.querySelectorAll('.wh-segments button')].map(el => el.textContent), ['状态', '项目', '设备']);
    assert.equal(h.doc.querySelector('.wh-segments .active').dataset.value, 'status');
    assert.equal(h.doc.querySelectorAll('.wh-segments [aria-pressed=true]').length, 1);
    assert.equal(h.doc.querySelectorAll('#wh-active .wh-session').length, 2);
    assert.equal(h.doc.querySelectorAll('#wh-completed .wh-session').length, 5);
    assert.equal(h.doc.querySelector('select, input[type=search], .active-card, #devices-section'), null);
    assert.match(h.doc.querySelector('.wh-attention').textContent, /1 个待处理/);
    h.workspace.render({ ...active, recentSessions: [...active.recentSessions, session('outside-recent-20')] }, devices);
    for (let i = 0; i < 3; i++) h.click('more-completed');
    assert.equal(h.doc.querySelectorAll('#wh-completed .wh-session').length, 20);
    assert.equal(h.doc.querySelector('[data-wh=more-completed]'), null);
    assert.ok(h.doc.querySelector('#wh-completed [data-device=mac]'));
    assert.ok(h.doc.querySelector('#wh-completed [data-device=linux]'));
    assert.equal(h.doc.querySelector('[data-sid=outside-recent-20]'), null);
  } finally { h.close(); }
});

test('legacy saved device filters are discarded for both status and project views', async () => {
  const calls = [];
  const h = harness(async (path, params) => {
    calls.push({ path, params });
    return overview();
  }, { mode: 'status', device: 'mac' });
  try {
    h.workspace.render({ ...active, sessions: [...active.sessions, session('linux-active', { deviceName: 'linux' })] }, devices);
    assert.equal(h.doc.querySelectorAll('#wh-active .wh-session').length, 3);
    assert.ok(h.doc.querySelector('#wh-completed [data-device=linux]'));
    assert.equal('device' in JSON.parse(h.dom.window.sessionStorage.getItem(HOME_UI_KEY)), false);
    h.click('mode', 'project');
    await tick();
    assert.deepEqual(calls, [{ path: '/api/bridge/project-sessions', params: { limit: 50 } }]);
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 2);
  } finally { h.close(); }
});

test('device view reuses original list styles and online/offline indicators without fetching projects', () => {
  const calls = [];
  const h = harness(async path => { calls.push(path); return {}; });
  try {
    h.click('mode', 'device');
    assert.equal(h.doc.querySelector('.wh-segments .active').dataset.value, 'device');
    assert.equal(h.doc.querySelectorAll('.wh-segments [aria-pressed=true]').length, 1);
    assert.equal(h.doc.querySelectorAll('.list > a.item.device-item').length, 2);
    assert.equal(h.doc.querySelector('#wh-active, .wh-project-group, select'), null);
    const mac = h.doc.querySelector('[data-nav=device][data-name=mac]');
    const linux = h.doc.querySelector('[data-nav=device][data-name=linux]');
    assert.equal(mac.getAttribute('href'), '#/mac');
    assert.equal(mac.querySelector('.item-top > .title').textContent, 'Office Mac');
    assert.equal(mac.querySelector('.device-dot.online').getAttribute('aria-label'), '在线');
    assert.match(mac.querySelector('.item-bottom > .subtitle').textContent, /macOS · 2 projects/);
    assert.equal(linux.querySelector('.device-dot.offline').getAttribute('aria-label'), '离线');
    assert.match(linux.querySelector('.subtitle').textContent, /Linux/);
    assert.deepEqual(calls, []);
    h.click('mode', 'status');
    assert.equal(h.doc.querySelectorAll('#wh-active .wh-session').length, 2);
    assert.equal(h.doc.querySelector('.device-item'), null);
  } finally { h.close(); }
});

test('home composes the original list, badge, runtime, section and button styles', () => {
  const h = harness();
  try {
    const row = h.doc.querySelector('.wh-session');
    assert.ok(row.matches('a.item.session-item'));
    assert.ok(row.parentElement.matches('.list'));
    assert.ok(row.querySelector('.item-main > .item-top > .title'));
    assert.ok(row.querySelector('.session-badges > .badge.running'));
    assert.ok(row.querySelector('.runtime-mark.runtime-mark-codex > .runtime-icon'));
    assert.ok(row.querySelector('.item-bottom.session-item-bottom .session-secondary-slot'));
    assert.ok(row.querySelector('.item-time'));
    assert.ok(h.doc.querySelector('.section-title.collapsible.expanded .collapse-arrow'));
    assert.ok(h.doc.querySelector('[data-wh=mode].file-tab.active'));
    assert.ok(h.doc.querySelector('[data-wh=more-completed].text-btn'));
    assert.equal(h.doc.querySelector('#wh-completed .badge.stopped').textContent, 'Done');
  } finally { h.close(); }
});

test('collapse and scroll preferences survive a settings roundtrip', () => {
  const h = harness();
  try {
    h.click('collapse', 'active');
    h.doc.getElementById('content').scrollTop = 250;
    h.doc.getElementById('content').dispatchEvent(new h.dom.window.Event('scroll'));
    h.workspace.dispose();
    const next = createWorkspaceHome({ window: h.dom.window, request: async () => ({}) });
    next.render(active, devices);
    assert.equal(h.doc.querySelector('#wh-active').hidden, true);
    assert.equal(h.doc.getElementById('content').scrollTop, 250);
    assert.equal(h.doc.querySelector('[data-wh=collapse]').getAttribute('aria-expanded'), 'false');
    next.dispose();
  } finally { h.close(); }
});

test('device tab and scroll survive refresh, deep navigation and a settings roundtrip', () => {
  const h = harness();
  let next;
  try {
    h.click('mode', 'device');
    h.doc.getElementById('content').scrollTop = 150;
    h.doc.getElementById('content').dispatchEvent(new h.dom.window.Event('scroll'));
    h.doc.body.classList.remove('workspace-home');
    h.doc.getElementById('content').innerHTML = '<div>Device projects</div>';
    h.doc.body.classList.add('workspace-home');
    h.workspace.render(active, devices);
    assert.equal(h.doc.querySelector('.wh-segments .active').dataset.value, 'device');
    assert.equal(h.doc.getElementById('content').scrollTop, 150);
    h.workspace.dispose();
    next = createWorkspaceHome({ window: h.dom.window, request: async () => { throw new Error('Must not load projects'); } });
    next.render(active, devices);
    assert.equal(h.doc.querySelector('.wh-segments .active').dataset.value, 'device');
    assert.equal(h.doc.getElementById('content').scrollTop, 150);
    assert.equal(h.doc.querySelectorAll('.device-item').length, 2);
    h.doc.querySelector('[data-wh=mode][data-value=status]').click();
    assert.equal(h.doc.getElementById('content').scrollTop, 0);
  } finally { next?.dispose(); h.close(); }
});

test('one overview request preloads all device groups and expansion needs no extra request', async () => {
  const calls = [];
  const h = harness(async (path, params) => {
    calls.push({ path, params });
    if (path.endsWith('/project-sessions')) return overview();
    return {
      sessions: Array.from({ length: params.cursor ? 4 : 5 }, (_, i) => session(params.device + (params.cursor ? '-next' : '-first') + i)),
      hasMore: !params.cursor, nextCursor: params.cursor ? null : 'opaque-cursor',
    };
  });
  try {
    assert.equal(calls.length, 0);
    h.click('mode', 'project');
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 2);
    assert.equal(h.doc.querySelectorAll('.wh-project-group.wh-section > .wh-section-heading h2 .wh-project-name').length, 2);
    assert.equal(h.doc.querySelector('.wh-project-toggle .wh-count').textContent, '9');
    assert.equal(h.doc.querySelector('.wh-project-symbol, .wh-project-head, .wh-project-intro'), null);
    assert.equal(calls.filter(c => c.path.endsWith('/sessions')).length, 0);
    const mac = JSON.stringify(['mac', 'baton']);
    const linux = JSON.stringify(['linux', 'baton']);
    h.click('project', mac);
    h.click('project', linux);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open').length, 2);
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 10);
    const firstGroup = h.doc.querySelector('.wh-project-group.open');
    assert.equal(firstGroup.querySelectorAll('.wh-session-list > .wh-session').length, 5);
    assert.equal(firstGroup.querySelector('.wh-project-heading .wh-project-path').textContent, '/work/baton');
    assert.doesNotMatch(firstGroup.querySelector('.wh-project-content').textContent, /\/work\/baton|已展示|打开项目 →/);
    assert.equal(firstGroup.querySelector('.wh-footer').textContent.trim(), '展示更多 ↓');
    assert.equal(firstGroup.querySelector('.wh-project-content [data-wh=open-project]'), null);
    assert.equal(firstGroup.querySelector('.wh-project-link, [data-wh=open-project]'), null);
    assert.equal(firstGroup.querySelectorAll('.item.session-item > .item-main > .item-top > .session-badges').length, 5,
      'both grouping modes use the original session list structure');
    assert.equal(calls.length, 1, 'both project groups use the overview preview without additional requests');
    h.click('more-sessions', mac);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 14);
    assert.equal(h.doc.querySelector('.wh-project-group.open').querySelectorAll('.wh-session').length, 9);
    assert.deepEqual(calls.at(-1).params, { device: 'mac', project: 'baton', limit: 5, cursor: 'opaque-cursor' });
    assert.equal(h.doc.querySelector('.wh-project-group.open').querySelector('[data-wh=more-sessions]'), null);
    assert.equal(h.doc.querySelector('.wh-project-group.open').querySelector('.wh-footer'), null);
    h.click('project', linux);
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open').length, 1);
    assert.equal(h.doc.querySelector('.wh-project-heading a'), null);
  } finally { h.close(); }
});

test('expanded single-page projects have no redundant footer or empty footer spacing', async () => {
  for (const count of [0, 1, 5]) {
    const h = harness(async () => overview([group('mac', 'baton', count)]));
    try {
      h.click('mode', 'project');
      await tick();
      h.click('project', JSON.stringify(['mac', 'baton']));
      await tick();
      const group = h.doc.querySelector('.wh-project-group.open');
      assert.equal(group.querySelectorAll('.wh-session').length, count);
      assert.equal(group.querySelector('.wh-footer, .wh-project-content .wh-project-path, [data-wh=open-project]'), null);
      assert.doesNotMatch(group.querySelector('.wh-project-content').textContent, /已展示|打开项目 →|\/work\/baton/);
      assert.equal(group.querySelector('.wh-project-toggle').title, '/work/baton');
      assert.equal(group.querySelector('.wh-project-heading .wh-project-path').textContent, '/work/baton');
      assert.equal(group.querySelector('.wh-project-link'), null);
      if (!count) assert.match(group.querySelector('.empty').textContent, /暂无会话/);
    } finally { h.close(); }
  }
});

test('same-name projects show their case-sensitive paths even when collapsed without navigation links', async () => {
  const paths = ['/Users/Office/Projects/Baton', '/Users/Office/.codex/worktrees/958e/Baton'];
  const calls = [];
  const h = harness(async path => {
    calls.push(path);
    return overview(paths.map((projectPath, i) => group('mac', 'directory-' + i, 1, { projectPath })));
  });
  try {
    h.dom.window.loadSessions = () => assert.fail('Project headings must not navigate');
    h.click('mode', 'project');
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open').length, 0);
    assert.deepEqual([...h.doc.querySelectorAll('.wh-project-path')].map(el => el.textContent).sort(), [...paths].sort());
    const keys = [...h.doc.querySelectorAll('.wh-project-toggle')].map(el => el.dataset.value);
    for (const key of keys) {
      const toggle = [...h.doc.querySelectorAll('.wh-project-toggle')].find(el => el.dataset.value === key);
      const heading = toggle.closest('.wh-project-heading');
      const path = heading.querySelector('.wh-project-path');
      assert.ok(path.classList.contains('meta-left'));
      assert.equal(toggle.getAttribute('aria-describedby'), path.id);
      assert.equal(path.closest('[hidden]'), null);
      path.click();
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      toggle.click();
      assert.equal(h.doc.getElementById(toggle.getAttribute('aria-controls')).hidden, false);
      assert.equal(h.doc.getElementById(path.id).closest('[hidden]'), null);
    }
    assert.equal(h.doc.querySelector('.wh-project-link, [data-wh=open-project], .wh-project-heading a'), null);
    assert.deepEqual(calls, ['/api/bridge/project-sessions']);
  } finally { h.close(); }
});

test('project paths are escaped and missing paths fall back to the project name', async () => {
  const unsafe = `/Users/CaseSensitive/'"><img src=x onerror=alert(1)>`;
  const h = harness(async () => overview([
    group('mac', 'unsafe', 1, { projectPath: unsafe }),
    group('linux', 'fallback', 1, { projectPath: '' }),
  ]));
  try {
    h.click('mode', 'project');
    await tick();
    const labels = [...h.doc.querySelectorAll('.wh-project-path')].map(el => el.textContent);
    assert.ok(labels.includes(unsafe));
    assert.ok(labels.includes('Baton'));
    assert.equal(h.doc.querySelector('[onerror], script'), null);
  } finally { h.close(); }
});

test('project metadata and session errors can be retried without discarding loaded rows', async () => {
  let failProjects = true;
  let failSessions = true;
  const h = harness(async path => {
    if (path.endsWith('/project-sessions')) {
      if (failProjects) throw new Error('offline');
      return overview([group()]);
    }
    if (failSessions) throw new Error('offline');
    return { sessions: [session('one')], hasMore: true, nextCursor: 'next' };
  });
  try {
    h.click('mode', 'project');
    await tick();
    assert.match(h.doc.querySelector('[role=alert]').textContent, /重试/);
    failProjects = false;
    h.click('more-projects');
    await tick();
    const key = JSON.stringify(['mac', 'baton']);
    h.click('project', key);
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 5);
    h.click('more-sessions', key);
    await tick();
    assert.match(h.doc.querySelector('[role=alert]').textContent, /重试/);
    failSessions = false;
    h.click('more-sessions', key);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 6);
    failSessions = true;
    h.click('more-sessions', key);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 6);
    assert.match(h.doc.querySelector('[role=alert]').textContent, /已保留/);
    failProjects = true;
    h.workspace.render(active, devices);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 6);
    assert.match(h.doc.querySelector('[role=alert]').textContent, /已保留/);
  } finally { h.close(); }
});

test('in-flight project responses cannot overwrite a session', async () => {
  const resolvers = [];
  const h = harness(() => new Promise(done => { resolvers.push(done); }));
  try {
    h.click('mode', 'project');
    h.doc.body.classList.remove('workspace-home');
    h.doc.getElementById('content').innerHTML = '<div class="messages">Session detail</div>';
    resolvers.forEach(resolve => resolve(overview()));
    await tick();
    assert.equal(h.doc.querySelector('.messages').textContent, 'Session detail');
    assert.equal(h.doc.querySelector('.wh-workspace'), null);
  } finally { h.close(); }
});

test('in-flight project responses preserve the currently selected status or device tab', async () => {
  for (const mode of ['status', 'device']) {
    const resolvers = [];
    const h = harness(() => new Promise(done => { resolvers.push(done); }));
    try {
      h.click('mode', 'project');
      assert.equal(resolvers.length, 1);
      h.click('mode', mode);
      resolvers.forEach(resolve => resolve(overview()));
      await tick();
      assert.equal(h.doc.querySelector('.wh-segments .active').dataset.value, mode);
      assert.equal(h.doc.querySelector('.wh-project-group'), null);
      assert.equal(h.doc.querySelectorAll(mode === 'device' ? '.device-item' : '#wh-active .wh-session').length, 2);
      assert.equal(resolvers.length, 1);
    } finally { h.close(); }
  }
});

test('server refresh updates status while retaining current grouping and open projects', async () => {
  let requestCount = 0;
  const h = harness(async path => {
    assert.equal(path, '/api/bridge/project-sessions');
    requestCount++;
    return overview([group('mac', 'baton', 1, {
      sessionPage: {
        sessions: [session('one', { status: requestCount > 1 ? 'completed' : 'running' })],
        hasMore: false, nextCursor: null,
      },
    })]);
  });
  try {
    h.click('mode', 'project');
    await tick();
    h.click('project', JSON.stringify(['mac', 'baton']));
    await tick();
    assert.match(h.doc.querySelector('.wh-status').textContent, /Running/);
    h.workspace.render(active, devices);
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open').length, 1);
    assert.match(h.doc.querySelector('.wh-status').textContent, /Done/);
  } finally { h.close(); }
});

test('project catalog pagination keeps distinct directory identities', async () => {
  const h = harness(async (_path, params) => ({
    projects: params.cursor ? [group('mac', 'other-dir'), group('linux')] : [group('mac'), group('linux')],
    hasMore: !params.cursor, nextCursor: params.cursor ? null : 'projects-next',
  }));
  try {
    h.click('mode', 'project');
    await tick();
    assert.equal(h.doc.querySelectorAll('[data-wh=more-projects]').length, 1);
    h.click('more-projects');
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 3);
    assert.equal(new Set([...h.doc.querySelectorAll('.wh-project-toggle')].map(button => button.dataset.value)).size, 3);
    assert.ok([...h.doc.querySelectorAll('.wh-project-toggle')].some(button => button.title === '/work/other-dir'));
  } finally { h.close(); }
});

test('the project overview does not depend on device records or apply online filtering', async () => {
  const calls = [];
  const h = harness(async (path, params) => {
    calls.push({ path, params });
    return overview([
      group('offline', 'same-name', 1, { deviceDisplayName: 'Offline machine' }),
      group('unlisted', 'same-name', 1, { deviceDisplayName: 'Missing device record' }),
    ]);
  });
  try {
    h.workspace.render(active, { devices: [] });
    h.click('mode', 'project');
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 2);
    assert.equal(h.doc.querySelector('a[href="setup.html"]'), null);
    assert.match(h.doc.body.textContent, /Offline machine/);
    assert.match(h.doc.body.textContent, /Missing device record/);
    h.click('project', JSON.stringify(['unlisted', 'same-name']));
    assert.equal(h.doc.querySelector('.wh-session').dataset.device, 'unlisted');
    assert.equal(calls.length, 1);
  } finally { h.close(); }
});

test('more than 96 open project groups do not evict the catalog or trigger refetch loops', async () => {
  const groups = Array.from({ length: 101 }, (_, i) => group('mac', 'dir-' + i, 1));
  const calls = [];
  const h = harness(async (path, params) => {
    calls.push({ path, params });
    assert.equal(path, '/api/bridge/project-sessions');
    const start = Number(params.cursor || 0);
    return {
      projects: groups.slice(start, start + 50), hasMore: start + 50 < groups.length,
      nextCursor: start + 50 < groups.length ? String(start + 50) : null,
    };
  }, { mode: 'project', projectPages: 3, open: groups.map(p => JSON.stringify([p.deviceName, p.projectHash])) });
  try {
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open').length, 101);
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 101);
    assert.equal(h.doc.querySelector('[data-wh=more-projects]'), null);
    assert.equal(calls.length, 3);
    await tick();
    assert.equal(calls.length, 3);
  } finally { h.close(); }
});

test('returning home restores catalog pages before restoring a later group session page', async () => {
  const key = JSON.stringify(['linux', 'later']);
  const calls = [];
  const h = harness(async (path, params) => {
    calls.push({ path, params });
    if (path === '/api/bridge/project-sessions') return {
      projects: [params.cursor ? group('linux', 'later') : group('mac', 'first')],
      hasMore: !params.cursor, nextCursor: params.cursor ? null : 'page-two',
    };
    return { sessions: [session('later-page-two')], hasMore: false, nextCursor: null };
  }, { mode: 'project', projectPages: 2, open: [key], sessionPages: { [key]: 2 }, scroll: 400 });
  try {
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-project-group').length, 2);
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open .wh-session').length, 6);
    assert.equal(h.doc.getElementById('content').scrollTop, 400);
    assert.deepEqual(calls.map(c => c.path), [
      '/api/bridge/project-sessions', '/api/bridge/project-sessions', '/api/bridge/sessions',
    ]);
    assert.deepEqual(calls[2].params, { device: 'linux', project: 'later', limit: 5, cursor: 'opaque-cursor' });
  } finally { h.close(); }
});

test('a stale overview cannot overwrite a newer refresh', async () => {
  const pending = [];
  const h = harness(() => new Promise(resolve => pending.push(resolve)));
  try {
    h.click('mode', 'project');
    h.workspace.render(active, devices);
    pending[0](overview([group('mac', 'stale')]));
    await tick();
    assert.equal(pending.length, 2);
    assert.equal(h.doc.querySelector('.wh-project-group'), null);
    pending[1](overview([group('linux', 'fresh')]));
    await tick();
    assert.equal(h.doc.querySelector('.wh-project-toggle').title, '/work/fresh');
  } finally { h.close(); }
});

test('a stale session page cannot overwrite refreshed preloaded sessions', async () => {
  let resolveMore;
  let refresh = false;
  const h = harness(async path => {
    if (path === '/api/bridge/project-sessions') return overview([refresh
      ? group('mac', 'baton', 1, {
        sessionPage: { sessions: [session('fresh', { status: 'completed' })], hasMore: false, nextCursor: null },
      }) : group()]);
    return new Promise(resolve => { resolveMore = resolve; });
  });
  try {
    h.click('mode', 'project');
    await tick();
    h.click('project', JSON.stringify(['mac', 'baton']));
    h.click('more-sessions');
    refresh = true;
    h.workspace.render(active, devices);
    await tick();
    resolveMore({ sessions: [session('stale')], hasMore: false, nextCursor: null });
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 1);
    assert.equal(h.doc.querySelector('.wh-session').dataset.sid, 'fresh');
    assert.equal(h.doc.querySelector('.wh-status').textContent, 'Done');
  } finally { h.close(); }
});

test('malformed aggregate responses surface an error instead of falling back to device queries', async () => {
  const calls = [];
  const h = harness(async path => {
    calls.push(path);
    return { projects: [project()], hasMore: false };
  });
  try {
    h.click('mode', 'project');
    await tick();
    assert.match(h.doc.querySelector('[role=alert]').textContent, /重试/);
    assert.equal(h.doc.querySelector('.wh-project-group'), null);
    assert.deepEqual(calls, ['/api/bridge/project-sessions']);
  } finally { h.close(); }
});

test('return from settings reloads previously expanded session pages rather than shrinking to page one', async () => {
  const key = JSON.stringify(['mac', 'baton']);
  const h = harness(async (path, params) => {
    if (path.endsWith('/project-sessions')) return overview([group()]);
    const offset = params.cursor ? 5 : 0;
    return {
      sessions: Array.from({ length: offset ? 4 : 5 }, (_, i) => session('s' + (offset + i))),
      hasMore: !offset, nextCursor: !offset ? 'next' : null,
    };
  }, { mode: 'project', open: [key], sessionPages: { [key]: 2 }, scroll: 400 });
  try {
    await tick();
    await tick();
    assert.equal(h.doc.querySelectorAll('.wh-session').length, 9);
    assert.equal(h.doc.querySelectorAll('.wh-project-group.open').length, 1);
    assert.equal(h.doc.getElementById('content').scrollTop, 400);
  } finally { h.close(); }
});

test('unknown saved modes default to status and an empty project overview has its own empty state', async () => {
  const h = harness(undefined, { mode: 'unknown', device: 'deleted-device' });
  try {
    assert.equal(h.doc.querySelector('.wh-segments .active').dataset.value, 'status');
    assert.equal(h.doc.querySelector('select'), null);
    h.workspace.render({ sessions: [], recentSessions: [] }, { devices: [] });
    for (const mode of ['status', 'device']) {
      h.click('mode', mode);
      assert.match(h.doc.querySelector('a[href="setup.html"]').textContent, /安装 Bridge/);
    }
    h.click('mode', 'project');
    await tick();
    assert.match(h.doc.querySelector('.empty').textContent, /暂无项目/);
    assert.equal(h.doc.querySelector('a[href="setup.html"]'), null);
  } finally { h.close(); }
});

test('untrusted device names and metadata are escaped and links preserve device identity', () => {
  const h = harness();
  try {
    const name = `device/'"><img src=x onerror=alert(1)>`;
    h.workspace.render(active, { devices: [{ deviceName: name, deviceDisplayName: name, os: '<script>x</script>' }] });
    h.click('mode', 'device');
    const row = h.doc.querySelector('.device-item');
    assert.equal(row.dataset.name, name);
    assert.equal(row.querySelector('.title').textContent, name);
    assert.equal(decodeURIComponent(row.getAttribute('href').slice(2)), name);
    assert.equal(h.doc.querySelector('[onerror], script'), null);
  } finally { h.close(); }
});

test('untrusted session values are escaped without losing full detail navigation', () => {
  const preview = `'"><img src=x onerror=alert(1)>`;
  const html = sessionRow(session('codex:a/b', { preview, deviceName: `a'"&`, projectName: '<script>x</script>' }), 'test');
  const dom = new JSDOM(html);
  try {
    const row = dom.window.document.querySelector('.wh-session');
    assert.equal(row.dataset.preview, preview);
    assert.equal(row.dataset.runtime, 'codex');
    assert.equal(dom.window.document.querySelector('[onerror], script'), null);
    assert.match(row.getAttribute('href'), /codex%3Aa%2Fb/);
    assert.equal(row.querySelector('.wh-row-title').textContent, preview);
  } finally { dom.window.close(); }
});
