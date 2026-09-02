import { state } from '../state.js';
import { registerEdgeBackLayer } from '../edge-back.js';
import { fileIconHtml } from '../components/file-icon.js';
import { FOLDER_ICON_SVG } from '../components/icons.js';
import { requestProjectFiles } from './rpc.js';
import {
  joinProjectPath,
  normalizeProjectPath,
  projectBreadcrumbItems,
} from './paths.js';
import {
  closeProjectFilesPage,
  openProjectFilesPage,
  projectFilesContent,
  renderProjectFilesBreadcrumb,
  setProjectFilesLoading,
} from './page.js';

var currentPath = '';
var navigationVersion = 0;
var PROJECT_FILES_VIEW_KEY = 'baton-project-files-view';
var edgeBack = registerEdgeBackLayer({
  navigateBack: closeProjectFiles,
  foregroundSelectors: ['#projectFilesPage'],
  guardZIndex: 902,
  foregroundZIndex: 900,
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function projectName() {
  return state.appState.project?.name || 'Project';
}

function saveProjectFilesView() {
  try {
    sessionStorage.setItem(PROJECT_FILES_VIEW_KEY, JSON.stringify({
      device: state.appState.device,
      projectHash: state.appState.project?.hash || '',
      path: currentPath,
    }));
  } catch (error) {}
}

function clearProjectFilesView() {
  try { sessionStorage.removeItem(PROJECT_FILES_VIEW_KEY); } catch (error) {}
}

function restoreProjectFilesView() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(PROJECT_FILES_VIEW_KEY) || 'null');
  } catch (error) {
    clearProjectFilesView();
    return false;
  }
  if (!saved
    || saved.device !== state.appState.device
    || saved.projectHash !== state.appState.project?.hash
    || state.appState.session) {
    if (saved) clearProjectFilesView();
    return false;
  }
  openProjectFilesPath(saved.path || '');
  return true;
}

function rowHtml(entry) {
  var iconHtml = entry.type === 'directory'
    ? FOLDER_ICON_SVG
    : fileIconHtml(entry.name);
  return '<button class="project-file-row" type="button" data-name="'
    + escapeHtml(entry.name) + '" data-type="' + escapeHtml(entry.type) + '">'
    + '<span class="project-file-icon ' + escapeHtml(entry.type) + '">'
    + iconHtml + '</span>'
    + '<span class="project-file-name">' + escapeHtml(entry.name) + '</span>'
    + (entry.type === 'directory'
      ? '<span class="project-file-chevron" aria-hidden="true">›</span>'
      : '')
    + '</button>';
}

function renderEntries(entries) {
  var content = projectFilesContent();
  if (!entries.length) {
    content.innerHTML = '<div class="empty">This folder is empty</div>';
    return;
  }
  content.innerHTML = '<div class="project-file-list">'
    + entries.map(rowHtml).join('') + '</div>';
  content.querySelectorAll('.project-file-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var nextPath = joinProjectPath(currentPath, row.dataset.name || '');
      if (row.dataset.type === 'directory') {
        openProjectFilesPath(nextPath);
      } else if (window.openFile) {
        window.openFile(nextPath, row.dataset.name || nextPath);
      }
    });
  });
}

async function loadDirectory(version) {
  var projectHash = state.appState.project?.hash || '';
  var entries = [];
  var cursor = '';
  do {
    var response = await requestProjectFiles('list', {
      projectHash: projectHash,
      path: currentPath,
      cursor: cursor,
    });
    if (!state.projectFilesOpen || version !== navigationVersion) return;
    entries = entries.concat(response.entries || []);
    cursor = response.nextCursor || '';
    renderEntries(entries);
  } while (cursor);
}

export async function openProjectFilesPath(path) {
  if (!state.appState.project) return;
  currentPath = normalizeProjectPath(path);
  saveProjectFilesView();
  state.projectFilesOpen = true;
  edgeBack.activate();
  openProjectFilesPage({
    onBack: closeProjectFiles,
    onNavigate: openProjectFilesPath,
  });
  navigationVersion++;
  var version = navigationVersion;
  renderProjectFilesBreadcrumb(projectBreadcrumbItems(projectName(), currentPath));
  setProjectFilesLoading(true);
  var content = projectFilesContent();
  content.innerHTML = '';
  content.scrollTop = 0;
  await window.loadViewerLibs();
  if (!state.projectFilesOpen || version !== navigationVersion) return;
  window.connectWs();
  try {
    await loadDirectory(version);
  } catch (error) {
    if (!state.projectFilesOpen || version !== navigationVersion) return;
    content.innerHTML = '<div class="empty">Unable to load files<br><br>'
      + '<span class="project-files-error">' + escapeHtml(error.message) + '</span></div>';
  } finally {
    if (state.projectFilesOpen && version === navigationVersion) {
      setProjectFilesLoading(false);
    }
  }
}

export function openProjectFiles() {
  return openProjectFilesPath('');
}

export function closeProjectFiles() {
  if (!state.projectFilesOpen) return false;
  deactivateProjectFiles();
  return true;
}

export function deactivateProjectFiles() {
  if (!state.projectFilesOpen) return false;
  state.projectFilesOpen = false;
  clearProjectFilesView();
  navigationVersion++;
  edgeBack.deactivate();
  closeProjectFilesPage();
  if (!state.wsSessionId) window.disconnectWs?.();
  return true;
}

export function projectFilesBack() {
  return closeProjectFiles();
}

Object.assign(window, {
  openProjectFiles: openProjectFiles,
  openProjectFilesPath: openProjectFilesPath,
  closeProjectFiles: closeProjectFiles,
  deactivateProjectFiles: deactivateProjectFiles,
  projectFilesBack: projectFilesBack,
});

queueMicrotask(function () {
  if (state.appState.project && !state.appState.session) {
    window.updateBreadcrumb?.();
    restoreProjectFilesView();
  }
});
