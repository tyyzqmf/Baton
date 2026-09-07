import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FILE_ICON_SVG,
  FOLDER_ICON_SVG,
} from '../../web/js/components/icons.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('project folder icon uses a compact square outline and shared icon source', () => {
  assert.match(FOLDER_ICON_SVG, /M4 5h6\.5l2 2H20v12H4z/);
  assert.match(FILE_ICON_SVG, /M6 3\.5h8l4 4v13H6z/);

  const app = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
  const browser = fs.readFileSync(path.join(ROOT, 'web/js/project/browser.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'web/css/project-files.css'), 'utf8');
  assert.match(app, /FOLDER_ICON_SVG/);
  assert.match(browser, /fileIconHtml\(entry\.name\)/);
  assert.match(
    app,
    /topRight\.innerHTML = gitButton \+ runtimeMark \+ filesButton[\s\S]*new-session-btn/,
  );
  assert.match(
    css,
    /\.project-files-entry \{[\s\S]*?width: 20px;[\s\S]*?height: 20px;[\s\S]*?flex: 0 0 20px;/,
  );
  assert.match(
    css,
    /\.project-files-entry svg \{[\s\S]*?position: absolute;[\s\S]*?left: 50%;[\s\S]*?width: 24px;[\s\S]*?stroke-width: 1\.5;[\s\S]*?transform: translate\(-50%, -50%\);/,
  );
  assert.match(
    css,
    /html\.native-mobile #top-right \.project-files-entry \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;[\s\S]*?flex-basis: 44px;/,
  );
  assert.match(
    css,
    /html\.native-mobile #top-right \.project-files-entry svg \{[\s\S]*?width: 26px;[\s\S]*?transform: translate\(calc\(-50% \+ 3px\), -50%\);/,
  );
  assert.doesNotMatch(css, /#breadcrumb > \.project-files-entry/);
});
