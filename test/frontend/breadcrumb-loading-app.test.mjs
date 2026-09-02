import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(
  new URL('../../web/js/app.js', import.meta.url),
  'utf8',
);

test('project and session list loading uses the current breadcrumb instead of extra spinners', () => {
  assert.match(
    appSource,
    /function setBreadcrumbLoading\(loading\)[\s\S]*setBreadcrumbItemsLoading\([\s\S]*querySelectorAll\('#breadcrumb \.breadcrumb-nav a'\)/,
  );
  assert.match(
    appSource,
    /function setListLoading\(loading\) \{[\s\S]*setBreadcrumbLoading\(loading\);[\s\S]*\}/,
  );
  assert.doesNotMatch(
    appSource,
    /content\.insertAdjacentHTML\('beforeend', '<div class="loading-more">/,
  );
  assert.doesNotMatch(
    appSource,
    /loadPagedList[\s\S]*window\.__setTopSync\(true\)/,
  );
});
