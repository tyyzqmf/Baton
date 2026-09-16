export function createWorkspaceRequest(win, localHomeApi = false) {
  return (path, params) => {
    const options = localHomeApi && path === '/api/bridge/project-sessions'
      ? { server: win.location.origin } : undefined;
    return win.api(path, params, options);
  };
}
