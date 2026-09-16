import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createWorkspaceHome } from '../../web/js/workspace-home.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

test('returning from settings restores the saved home frame during parsing', () => {
  const snapshot = {
    topBarHtml: '<div class="top-left">Saved home</div><div id="top-right"><a class="top-gear"></a></div>',
    breadcrumbHtml: '',
    breadcrumbDisplay: 'none',
    contentHtml: '<div id="saved-home-frame" data-nav="device" data-name="phone">Saved content</div>',
    scrollTop: 24,
  };

  const dom = new JSDOM(indexHtml, {
    url: 'http://baton.test/index.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test_key'));
      window.sessionStorage.setItem('baton-returning-home', '1');
      window.sessionStorage.setItem('baton-page-preview', JSON.stringify(snapshot));
      window.fetch = () => new Promise(() => {});
    },
  });

  assert.equal(dom.window.document.getElementById('saved-home-frame')?.textContent, 'Saved content');
  assert.equal(dom.window.document.body.classList.contains('ready'), true);
  assert.equal(dom.window.__homePreviewRestored, true);
  assert.equal(dom.window.__inlineRendered, true);
  dom.window.close();
});

test('restoring the compact home also hydrates the controller data before unchanged-cache revalidation', () => {
  const cached = {
    active: { sessions: [{ sessionId: 'one' }], recentSessions: [] },
    devices: { devices: [{ deviceName: 'mac' }] },
  };
  const dom = new JSDOM(indexHtml, {
    url: 'http://baton.test/index.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test_key'));
      window.localStorage.setItem('apeek_home_cache', JSON.stringify(cached));
      window.sessionStorage.setItem('baton-returning-home', '1');
      window.sessionStorage.setItem('baton-page-preview', JSON.stringify({
        contentHtml: '<main class="wh-workspace">Saved home</main>',
        scrollTop: 240,
      }));
      window.fetch = () => new Promise(() => {});
    },
  });
  try {
    assert.equal(dom.window.document.body.classList.contains('workspace-home'), true);
    assert.equal(dom.window.__workspaceData.devices.devices[0].deviceName, 'mac');
    assert.equal(dom.window.__workspaceData.active.sessions[0].sessionId, 'one');
  } finally { dom.window.close(); }
});

test('a snapshot from the replaced custom header cannot override the original app header', () => {
  const dom = new JSDOM(indexHtml, {
    url: 'http://baton.test/index.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test_key'));
      window.sessionStorage.setItem('baton-returning-home', '1');
      window.sessionStorage.setItem('baton-page-preview', JSON.stringify({
        topBarHtml: '<button class="top-home-button">Old custom header</button>',
        contentHtml: '<main class="wh-workspace">Old custom layout</main>',
      }));
      window.fetch = () => new Promise(() => {});
    },
  });
  try {
    assert.equal(dom.window.document.querySelector('.top-home-button'), null);
    assert.equal(dom.window.document.querySelector('.top-left .top-title').textContent, 'Baton');
    assert.equal(dom.window.sessionStorage.getItem('baton-page-preview'), null);
  } finally { dom.window.close(); }
});

test('home device rows reuse existing navigation while retaining modified-click links', () => {
  const dom = new JSDOM(indexHtml, {
    url: 'http://baton.test/index.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test_key'));
      window.fetch = () => new Promise(() => {});
    },
  });
  const routes = [];
  dom.window.loadProjects = device => routes.push(device);
  const workspace = createWorkspaceHome({
    window: dom.window,
    request: async () => { throw new Error('Device view must not preload projects'); },
    onRender: () => dom.window.__bindHomeNavigation(dom.window.document.getElementById('content')),
  });
  try {
    dom.window.document.body.classList.add('workspace-home');
    workspace.render({}, { devices: [{ deviceName: 'office/mac', online: true }] });
    dom.window.document.querySelector('[data-wh=mode][data-value=device]').click();
    const row = dom.window.document.querySelector('[data-nav=device]');
    assert.equal(row.getAttribute('href'), '#/office%2Fmac');
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true });
      let intercepted;
      dom.window.document.addEventListener('click', e => {
        intercepted = e.defaultPrevented;
        e.preventDefault();
      }, { once: true });
      row.dispatchEvent(event);
      assert.equal(intercepted, false);
    }
    assert.deepEqual(routes, []);
    row.click();
    assert.deepEqual(routes, ['office/mac']);
  } finally { workspace.dispose(); dom.window.close(); }
});
