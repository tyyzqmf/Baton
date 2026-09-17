let runtimePromise = null;

function initializeIcons() {
  const runtime = globalThis.lucide;
  const createIcons = runtime.createIcons;
  runtime.createIcons = function (options = {}) {
    return createIcons({
      icons: runtime.icons,
      ...options,
      attrs: { width: 16, height: 16, ...options.attrs },
    });
  };
  document.addEventListener('DOMContentLoaded', function () {
    runtime.createIcons({
      root: {
        querySelectorAll(selector) {
          return document.querySelectorAll(selector + ':not(svg)');
        },
      },
    });
  }, { once: true });
}

export function createVisualizationIconRuntime(source) {
  return (source.replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    + '\n;(' + initializeIcons.toString() + ')();').replace(/<\/script/gi, '<\\/script');
}

export function loadVisualizationIcons() {
  if (!runtimePromise) {
    runtimePromise = import('lucide/dist/umd/lucide.min.js?raw')
      .then(module => createVisualizationIconRuntime(module.default))
      .catch(error => { runtimePromise = null; throw error; });
  }
  return runtimePromise;
}
