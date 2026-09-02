import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  BACK_ICON_SVG,
  backButtonHtml,
} from '../../web/js/components/back-button.js';

test('settings and project files share one back button component', () => {
  assert.match(BACK_ICON_SVG, /m15 6-6 6 6 6/);
  assert.match(backButtonHtml(), /class="back-button"/);

  const breadcrumb = fs.readFileSync(
    new URL('../../web/js/components/breadcrumb.js', import.meta.url),
    'utf8',
  );
  const setupEntry = fs.readFileSync(
    new URL('../../web/js/entry-setup.js', import.meta.url),
    'utf8',
  );
  const setupHtml = fs.readFileSync(
    new URL('../../web/setup.html', import.meta.url),
    'utf8',
  );

  assert.match(breadcrumb, /backButtonHtml\(\{ className: 'path-breadcrumb-back' \}\)/);
  assert.match(setupEntry, /mountBackButton\(document\.getElementById\('setupBackButton'\), leaveSetup\)/);
  assert.match(setupEntry, /attachPageEdgeBackGesture\(leaveSetup,/);
  assert.doesNotMatch(setupHtml, /class="back"/);
  assert.doesNotMatch(setupHtml, /<polyline points="15 18 9 12 15 6"/);
});
