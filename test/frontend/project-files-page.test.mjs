import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('project files page owns its breadcrumb and scroll container without replacing the session list', async () => {
  const dom = new JSDOM(
    '<!DOCTYPE html><body><button id="files-entry">Files</button>'
      + '<div id="content"><div id="session-list">Sessions</div></div></body>',
    { url: 'https://test/', pretendToBeVisual: true },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = function (callback) {
    callback();
    return 1;
  };

  const pageModule = await import(
    path.join(ROOT, 'web/js/project/page.js') + '?project-page-test'
  );
  var backCount = 0;
  var navigated = '';
  document.getElementById('files-entry').focus();
  pageModule.openProjectFilesPage({
    onBack: function () { backCount++; },
    onNavigate: function (value) { navigated = value; },
  });
  pageModule.renderProjectFilesBreadcrumb([
    { label: 'agentpeek', value: '' },
    { label: 'web', value: 'web' },
  ]);
  const page = pageModule.projectFilesPageElement();
  assert.equal(page.querySelector('.path-breadcrumb-loading'), null);
  pageModule.setProjectFilesLoading(true);
  assert.equal(page.querySelector('[data-value="web"]').classList.contains('is-loading'), true);
  assert.equal(page.querySelector('[data-value="web"]').getAttribute('aria-busy'), 'true');
  pageModule.setProjectFilesLoading(false);
  assert.equal(page.querySelector('[data-value="web"]').classList.contains('is-loading'), true);
  assert.equal(page.querySelector('[data-value="web"]').classList.contains('is-loading-ending'), true);
  assert.equal(page.querySelector('[data-value="web"]').hasAttribute('aria-busy'), false);
  await new Promise(function (resolve) { setTimeout(resolve, 240); });
  assert.equal(page.querySelector('[data-value="web"]').classList.contains('is-loading'), false);
  assert.equal(page.querySelector('[data-value="web"]').classList.contains('is-loading-ending'), false);
  pageModule.projectFilesContent().innerHTML = '<div id="project-file-row">app.js</div>';

  assert.equal(page.hidden, false);
  assert.equal(document.getElementById('session-list').textContent, 'Sessions');
  assert.equal(document.getElementById('project-file-row').textContent, 'app.js');
  assert.equal(page.querySelector('.path-breadcrumb-back').getAttribute('aria-label'), 'Back');
  assert.match(
    page.querySelector('.path-breadcrumb-back path').getAttribute('d'),
    /15 6-6 6 6 6/,
  );
  page.querySelector('[data-value="web"]').click();
  assert.equal(navigated, 'web');
  page.querySelector('.path-breadcrumb-back').click();
  assert.equal(backCount, 1);

  page.querySelector('.path-breadcrumb-back').focus();
  pageModule.closeProjectFilesPage();
  assert.equal(page.hidden, true);
  assert.equal(page.hasAttribute('aria-hidden'), false);
  assert.equal(document.activeElement, document.getElementById('files-entry'));
  assert.equal(document.getElementById('session-list').textContent, 'Sessions');
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.requestAnimationFrame;
});

test('shared breadcrumb keeps desktop and native-mobile item widths aligned with the existing UI', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/css/breadcrumb.css'), 'utf8');
  assert.match(css, /\.path-breadcrumb-item \{[\s\S]*?max-width: 240px;/);
  assert.match(
    css,
    /html\.native-mobile \.path-breadcrumb-item \{[\s\S]*?max-width: 140px;[\s\S]*?font-size: 13px;/,
  );
  assert.match(css, /\.path-breadcrumb-item\.is-loading,\s*\.breadcrumb-nav a\.is-loading/);
});

test('project file rows stay compact while preserving the native-mobile touch target', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/css/project-files.css'), 'utf8');
  assert.match(
    css,
    /\.project-file-list \{\s*padding: 0 0 var\(--sab, env\(safe-area-inset-bottom, 0px\)\);/,
  );
  assert.match(
    css,
    /\.project-file-row \{[\s\S]*?min-height: 42px;[\s\S]*?padding: 8px 16px;/,
  );
  assert.match(
    css,
    /html\.native-mobile \.project-file-row \{[\s\S]*?min-height: 44px;[\s\S]*?padding: 9px 16px 9px 12px;/,
  );
  assert.match(
    css,
    /@media \(orientation: landscape\) \{[\s\S]*?project-files-page-breadcrumb[\s\S]*?--sal[\s\S]*?--sar/,
  );
  assert.match(
    css,
    /project-files-page-content \{[\s\S]*?padding-left: var\(--sal,[\s\S]*?padding-right: var\(--sar,/,
  );
});
