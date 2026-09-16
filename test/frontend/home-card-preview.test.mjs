import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createWorkspaceHome } from '../../web/js/workspace-home.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

async function waitFor(predicate) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  throw new Error('Timed out waiting for inline home render');
}

test('compact home preserves quoted session previews, runtime and agent identity for navigation', async () => {
  const preview = '{"action":"send_message","text":"quoted title"}';
  const active = {
    sessions: [{
      sessionId: 'codex:test-session',
      preview,
      status: 'running',
      deviceName: 'MacBook-Pro',
      projectHash: '-workspace-baton',
      projectName: 'baton',
      isAgent: true,
      agentName: 'Review agent',
      agentCount: 3,
      lastActive: '2026-08-12T00:00:00.000Z',
    }],
    recentSessions: [],
  };
  const devices = {
    devices: [{
      deviceName: 'MacBook-Pro',
      deviceDisplayName: 'Office Mac',
    }],
  };
  const dom = new JSDOM(indexHtml, {
    url: 'http://baton.test/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      const workspace = createWorkspaceHome({ window, request: async () => ({}) });
      window.__renderWorkspace = workspace.render;
      window.localStorage.setItem('_ak', window.btoa('test-key'));
      window.fetch = async function (url) {
        return {
          ok: true,
          json: async function () {
            return String(url).includes('active-sessions') ? active : devices;
          },
        };
      };
    },
  });

  try {
    await waitFor(function () {
      return dom.window.document.querySelector('.wh-session[data-nav="active"]');
    });
    assert.equal(
      dom.window.document.querySelector('.wh-session[data-nav="active"]').dataset.preview,
      preview,
    );
    assert.equal(
      dom.window.document.querySelector('.wh-session[data-nav="active"]').dataset.device,
      'MacBook-Pro',
    );
    assert.match(dom.window.document.querySelector('.wh-scope').textContent, /Office Mac/);
    assert.equal(dom.window.document.querySelector('.wh-agent').textContent, '3 agents');
    assert.equal(dom.window.document.querySelector('.wh-status').textContent, 'Running');
    assert.equal(dom.window.document.querySelector('.wh-runtime').getAttribute('aria-label'), 'Codex');
    assert.equal(dom.window.document.querySelector('.wh-runtime img').alt, '');
    const row = dom.window.document.querySelector('.wh-session');
    assert.equal(row.dataset.runtime, 'codex');
    assert.equal(row.dataset.isagent, 'true');
    let opened;
    dom.window.loadProjects = () => {};
    dom.window.openActiveSession = element => { opened = element.dataset.preview; };
    row.click();
    assert.equal(opened, preview);
    assert.equal(dom.window.location.hash, '', 'normal click uses existing message navigation');
  } finally {
    dom.window.close();
  }
});
