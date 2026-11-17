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
const calls = [];
w.api = async path => {
  calls.push(path);
  return path.endsWith('/devices') ? { devices: [] } : { sessions: [], recentProjects: [] };
};
// The sidebar's 60 s refresh timer would keep the test process alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
test.after(() => {
  globalThis.setInterval = realSetInterval;
  dom.window.close();
});

async function boot(name, cachedAt) {
  calls.length = 0;
  localStorage.setItem('apeek_home_cache', JSON.stringify({
    active: { sessions: [], recentProjects: [] }, devices: { devices: [] }, cachedAt,
  }));
  document.getElementById('sidebar').replaceChildren();
  await import(`../../web/js/sidebar.js?${name}`);
  await new Promise(resolve => setTimeout(resolve, 0));
  return [...calls];
}

test('a sidebar loaded after the inline home fetch reuses its fresh cache', async () => {
  assert.deepEqual(await boot('fresh', Date.now() - 2000), []);
});

test('a sidebar with only an old cache fetches its data once on load', async () => {
  assert.deepEqual(await boot('stale', Date.now() - 60000),
    ['/api/bridge/active-sessions', '/api/bridge/devices']);
});
