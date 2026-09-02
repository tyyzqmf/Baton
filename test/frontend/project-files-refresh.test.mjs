import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../../web/js/project/browser.js', import.meta.url),
  'utf8',
);

test('project files persist their project and directory across a browser refresh', () => {
  assert.match(source, /PROJECT_FILES_VIEW_KEY = 'baton-project-files-view'/);
  assert.match(
    source,
    /sessionStorage\.setItem\(PROJECT_FILES_VIEW_KEY, JSON\.stringify\(\{[\s\S]*device:[\s\S]*projectHash:[\s\S]*path: currentPath/,
  );
  assert.match(
    source,
    /saved\.device !== state\.appState\.device[\s\S]*saved\.projectHash !== state\.appState\.project\?\.hash/,
  );
  assert.match(source, /openProjectFilesPath\(saved\.path \|\| ''\)/);
  assert.match(
    source,
    /state\.projectFilesOpen = false;\s*clearProjectFilesView\(\);/,
  );
});
