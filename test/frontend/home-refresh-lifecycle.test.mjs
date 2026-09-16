import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '../..');
const html = readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const session = {
  sessionId: 'session', preview: 'Cached session', deviceName: 'device',
  projectHash: 'project', projectName: 'Project', status: 'running',
  lastActive: '2026-09-16T04:00:00Z',
};
const cached = {
  active: { sessions: [session], recentSessions: [] },
  devices: { devices: [{ deviceName: 'device', online: true, projectCount: 1 }] },
};
const fresh = { ...cached.active, sessions: [{ ...session, preview: 'Fresh session' }] };
const overview = {
  projects: [{
    deviceName: 'device', projectHash: 'project', projectName: 'Project',
    projectPath: '/fixture/project', lastActive: session.lastActive, sessionCount: 1,
    sessionPage: { sessions: [session], hasMore: false, nextCursor: null },
  }],
  hasMore: false, nextCursor: null,
};
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function harness(mode = 'status', returning = false) {
  const calls = [];
  const request = path => new Promise((resolve, reject) => calls.push({ path, resolve, reject, settled: false }));
  const dom = new JSDOM(html, {
    url: 'https://baton.test/index.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('fixture-only-key'));
      window.localStorage.setItem('apeek_home_cache', JSON.stringify(cached));
      window.sessionStorage.setItem('baton-home-ui', JSON.stringify({ mode }));
      if (returning) {
        window.sessionStorage.setItem('baton-returning-home', '1');
        window.sessionStorage.setItem('baton-page-preview', JSON.stringify({
          topBarHtml: '<div class="top-left">Baton</div><div id="top-right"><a class="top-gear"></a></div>',
          contentHtml: '<main class="wh-workspace">Saved home</main>',
          scrollTop: 0,
        }));
      }
      window.fetch = async url => ({
        ok: true,
        json: async () => request(new URL(url).pathname),
      });
    },
  });
  const win = dom.window;
  const initialRun = win.__homeLoadPromise;
  const previous = new Map();
  function expose(key, value) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  for (const key of [
    'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'Element', 'HTMLElement', 'Node', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ]) expose(key, key === 'window' ? win : win[key]);
  win.Element.prototype.scrollTo = function () {};
  for (const [key, value] of Object.entries({
    api: request, disconnectWs() {}, updateSpinner() {},
    skeletonItems: () => '', skeletonMessages: () => '',
    loadViewerLibs: () => new Promise(() => {}),
  })) {
    expose(key, value);
    win[key] = value;
  }
  const vite = await createServer({
    root: path.join(ROOT, 'web'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true },
  });
  await tick();
  await vite.ssrLoadModule('/js/workspace-entry.js');
  const { state } = await vite.ssrLoadModule('/js/state.js');
  state.KEY = '';
  await vite.ssrLoadModule('/js/app.js');
  return {
    win, calls, initialRun,
    count(path) { return calls.filter(call => call.path === path).length; },
    answer(path, data, error) {
      const call = calls.find(call => call.path === path && !call.settled);
      assert.ok(call, `Missing pending request: ${path}`);
      call.settled = true;
      if (error) call.reject(error);
      else call.resolve(data);
    },
    async close() {
      await vite.close();
      win.close();
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      });
    },
  };
}

test('coalesced home refreshes still apply the shared response to both DOM and cache', async () => {
  const h = await harness();
  try {
    h.answer('/api/bridge/active-sessions', cached.active);
    h.answer('/api/bridge/devices', cached.devices);
    await h.initialRun;
    const first = h.win.loadDevices();
    const second = h.win.loadDevices();
    h.answer('/api/bridge/active-sessions', fresh);
    h.answer('/api/bridge/devices', cached.devices);
    await Promise.all([first, second]);
    assert.equal(h.count('/api/bridge/active-sessions'), 2, 'one startup request and one shared refresh');
    assert.equal(h.win.document.querySelector('.wh-row-title').textContent, 'Fresh session');
    assert.equal(JSON.parse(h.win.localStorage.getItem('apeek_home_cache')).active.sessions[0].preview, 'Fresh session');
  } finally { await h.close(); }
});

test('leaving home still invalidates a coalesced refresh rather than overwriting the new page', async () => {
  const h = await harness();
  try {
    h.answer('/api/bridge/active-sessions', cached.active);
    h.answer('/api/bridge/devices', cached.devices);
    await h.initialRun;
    const first = h.win.loadDevices();
    const second = h.win.loadDevices();
    const nextPage = h.win.loadProjects('other-device');
    h.answer('/api/bridge/active-sessions', fresh);
    h.answer('/api/bridge/devices', cached.devices);
    h.answer('/api/bridge/projects', { projects: [], hasMore: false, nextCursor: null });
    await Promise.all([first, second, nextPage]);
    assert.equal(h.win.document.querySelector('.wh-workspace'), null);
    assert.equal(JSON.parse(h.win.localStorage.getItem('apeek_home_cache')).active.sessions[0].preview, 'Cached session');
  } finally { await h.close(); }
});

for (const projectFirst of [false, true]) {
  test(`cached and fresh home renders share one project request (${projectFirst ? 'project' : 'status'} responds first)`, async () => {
    const h = await harness('project');
    try {
      assert.equal(h.count('/api/bridge/project-sessions'), 1);
      if (projectFirst) {
        h.answer('/api/bridge/project-sessions', overview);
        await tick();
      }
      h.answer('/api/bridge/active-sessions', fresh);
      h.answer('/api/bridge/devices', cached.devices);
      await h.initialRun;
      if (!projectFirst) h.answer('/api/bridge/project-sessions', overview);
      await tick();
      assert.equal(h.count('/api/bridge/project-sessions'), 1);
      assert.equal(h.win.document.querySelectorAll('.wh-project-group').length, 1);

      const refresh = h.win.loadDevices();
      assert.equal(h.count('/api/bridge/project-sessions'), 2, 'a new explicit home refresh still revalidates projects');
      h.answer('/api/bridge/active-sessions', cached.active);
      h.answer('/api/bridge/devices', cached.devices);
      h.answer('/api/bridge/project-sessions', overview);
      await refresh;
      await tick();
      assert.equal(h.count('/api/bridge/project-sessions'), 2);
    } finally { await h.close(); }
  });
}

test('status completion does not erase a project refresh error or silently retry it', async () => {
  const h = await harness('project');
  try {
    h.answer('/api/bridge/project-sessions', null, new Error('offline'));
    await tick();
    assert.ok(h.win.document.querySelector('[role=alert]'));
    h.answer('/api/bridge/active-sessions', fresh);
    h.answer('/api/bridge/devices', cached.devices);
    await h.initialRun;
    await tick();
    assert.equal(h.count('/api/bridge/project-sessions'), 1);
    assert.ok(h.win.document.querySelector('[role=alert]'));
    h.win.document.querySelector('[data-wh=more-projects]').click();
    assert.equal(h.count('/api/bridge/project-sessions'), 2);
    h.answer('/api/bridge/project-sessions', overview);
    await tick();
    assert.equal(h.win.document.querySelector('[role=alert]'), null);
  } finally { await h.close(); }
});

test('settings preview hydration shares its refresh identity with the fresh home response', async () => {
  const h = await harness('project', true);
  try {
    assert.equal(h.win.__homePreviewRestored, true);
    assert.equal(h.count('/api/bridge/project-sessions'), 1);
    h.answer('/api/bridge/active-sessions', fresh);
    h.answer('/api/bridge/devices', cached.devices);
    await h.initialRun;
    h.answer('/api/bridge/project-sessions', overview);
    await tick();
    assert.equal(h.count('/api/bridge/project-sessions'), 1);
    assert.equal(h.win.document.querySelectorAll('.wh-project-group').length, 1);
  } finally { await h.close(); }
});
