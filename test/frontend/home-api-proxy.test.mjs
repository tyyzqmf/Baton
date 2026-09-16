import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

test('only dev overview requests use the optional local proxy; builds and previews never enable it', async () => {
  const names = ['BATON_HOME_API_TARGET', 'BATON_API_URL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.BATON_HOME_API_TARGET = 'http://127.0.0.1:8081';
    process.env.BATON_API_URL = 'https://cloud.example.test';
    const configFile = fileURLToPath(new URL('../../vite.config.js', import.meta.url));
    const read = async (command, isPreview = false) => (await loadConfigFromFile({
      command, mode: command === 'build' ? 'production' : 'development', isPreview,
    }, configFile)).config;
    const dev = await read('serve');
    assert.equal(dev.define.__LOCAL_HOME_API__, 'true');
    const keys = Object.keys(dev.server.proxy);
    const local = new RegExp(keys[0]);
    assert.ok(local.test('/api/bridge/project-sessions?limit=50'));
    assert.ok(local.test('/api/bridge/project-sessions'));
    assert.equal(local.test('/api/bridge/sessions?device=mac'), false);
    assert.equal(local.test('/api/bridge/project-sessions-extra'), false);
    assert.equal(dev.server.proxy[keys[0]].target, 'http://127.0.0.1:8081');
    assert.equal(dev.server.proxy['/api'].target, 'https://cloud.example.test');
    for (const config of [await read('build'), await read('serve', true)]) {
      assert.equal(config.define.__LOCAL_HOME_API__, 'false');
      assert.deepEqual(Object.keys(config.server.proxy), ['/api']);
      assert.deepEqual(Object.keys(config.preview.proxy), ['/api']);
    }
    process.env.BATON_HOME_API_TARGET = '';
    assert.equal((await read('serve')).define.__LOCAL_HOME_API__, 'false');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
