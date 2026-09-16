import { createWorkspaceHome } from './workspace-home.js';
import { createWorkspaceRequest } from './workspace-api.js';

const workspace = createWorkspaceHome({
  window,
  request: createWorkspaceRequest(window, typeof __LOCAL_HOME_API__ !== 'undefined' && __LOCAL_HOME_API__),
  onRender: () => window.__bindHomeNavigation?.(document.getElementById('content')),
});
window.__renderWorkspace = workspace.render;
if (window.__workspaceData && document.body.classList.contains('workspace-home')) {
  workspace.render(window.__workspaceData.active, window.__workspaceData.devices, window.__workspaceData.refreshId);
}
