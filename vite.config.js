import { resolve } from 'path';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

function localConfig(name) {
  if (name in process.env) return process.env[name].trim();
  try {
    const txt = readFileSync(resolve(__dirname, '.env.local'), 'utf-8');
    const m = txt.match(new RegExp('^' + name + '=(.+)$', 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

export default defineConfig(({ command, isPreview }) => {
  const apiUrl = localConfig('BATON_API_URL');
  const homeTarget = command === 'serve' && !isPreview ? localConfig('BATON_HOME_API_TARGET') : '';
  return {
    root: 'web',
    base: './',
    cacheDir: '../node_modules/.vite',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __LOCAL_HOME_API__: JSON.stringify(!!homeTarget),
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index:   resolve(__dirname, 'web/index.html'),
          landing: resolve(__dirname, 'web/landing.html'),
          setup:   resolve(__dirname, 'web/setup.html'),
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        ...(homeTarget ? {
          '^/api/bridge/project-sessions(?:\\?|$)': { target: homeTarget, changeOrigin: true },
        } : {}),
        ...(apiUrl ? { '/api': { target: apiUrl, changeOrigin: true, secure: true } } : {}),
      },
    },
    preview: {
      port: 4173,
      strictPort: true,
      proxy: apiUrl ? {
        '/api': { target: apiUrl, changeOrigin: true, secure: true },
      } : undefined,
    },
  };
});
