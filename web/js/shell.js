// Shell actions shared by the home tabs, the desktop sidebar and the session header.
import { state } from './state.js';
import { PIN_ICON_SVG } from './components/icons.js';
import { layoutPixels } from './page-zoom.js';

const PINS_KEY = 'baton-pins';
const SIDEBAR_KEY = 'baton-sidebar-collapsed';
const MAX_PINS = 50;

function esc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function readPins() {
  try {
    const pins = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.isArray(pins)
      ? pins.filter(pin => pin && pin.sessionId && pin.deviceName && pin.projectHash)
      : [];
  } catch {
    return [];
  }
}

function writePins(pins) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins.slice(0, MAX_PINS))); } catch {}
  window.dispatchEvent(new CustomEvent('baton:pins'));
}

export function isPinned(deviceName, sessionId) {
  return readPins().some(pin => pin.deviceName === deviceName && pin.sessionId === sessionId);
}

export function togglePin(entry) {
  if (!entry?.sessionId || !entry.deviceName || !entry.projectHash) return false;
  const pins = readPins();
  const index = pins.findIndex(pin => pin.deviceName === entry.deviceName && pin.sessionId === entry.sessionId);
  if (index >= 0) {
    pins.splice(index, 1);
    writePins(pins);
    return false;
  }
  writePins([{
    sessionId: entry.sessionId,
    deviceName: entry.deviceName,
    projectHash: entry.projectHash,
    projectName: entry.projectName || entry.projectHash,
    preview: entry.preview || '',
    isAgent: !!entry.isAgent,
    pinnedAt: new Date().toISOString(),
  }, ...pins]);
  return true;
}

function currentSessionEntry() {
  const app = state.appState;
  const sessionId = state.rootSessionId || app.session;
  if (!sessionId || sessionId === '__new__' || !app.device || !app.project) return null;
  return {
    sessionId,
    deviceName: app.device,
    projectHash: app.project.hash,
    projectName: app.project.name,
    preview: state.rootSessionPreview || app.sessionPreview || '',
    isAgent: !!app.isAgent,
  };
}

export function sessionPinButton() {
  const entry = currentSessionEntry();
  if (!entry) return '';
  const pinned = isPinned(entry.deviceName, entry.sessionId);
  const label = pinned ? 'Unpin session' : 'Pin session';
  return '<button class="session-pin-button' + (pinned ? ' pinned' : '') + '" type="button"'
    + ' title="' + label + '" aria-label="' + label + '" aria-pressed="' + pinned + '"'
    + ' onclick="event.stopPropagation();toggleCurrentPin()">' + PIN_ICON_SVG + '</button>';
}

export function toggleCurrentPin() {
  togglePin(currentSessionEntry());
  window.updateBreadcrumb?.();
}

export function startNewSessionIn(device, projectHash, projectName) {
  state.appState = {
    device,
    project: { hash: projectHash, name: projectName || projectHash },
    session: null,
    sessionPreview: '',
  };
  return window.startNewSession(projectHash);
}

export function openProjectReview(device, projectHash, projectName) {
  window.loadSessions(device, projectHash, projectName);
  return window.openGitStatusPage();
}

function homeProjects() {
  return window.__homeProjects?.() || [];
}

function onNewTaskKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeNewTaskSheet();
}

export function closeNewTaskSheet() {
  document.getElementById('newTaskSheet')?.remove();
  document.removeEventListener('keydown', onNewTaskKeydown, true);
}

export function openNewTaskSheet() {
  closeNewTaskSheet();
  const projects = homeProjects();
  const deviceName = name => window.__deviceDisplayNames?.[name] || name;
  const rows = projects.map(project => '<button class="recent-project" type="button"'
    + ' data-device="' + esc(project.deviceName) + '" data-phash="' + esc(project.projectHash) + '"'
    + ' data-pname="' + esc(project.projectName) + '">'
    + '<svg class="recent-project-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M3 9V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z"/><path d="M3 9h18"/></svg>'
    + '<span class="recent-project-context"><span class="recent-project-name">' + esc(project.projectName) + '</span>'
    + '<span class="recent-project-device">' + esc(deviceName(project.deviceName)) + '</span></span>'
    + '<svg class="row-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button>').join('');
  const sheet = document.createElement('div');
  sheet.id = 'newTaskSheet';
  sheet.className = 'modal-overlay new-task-overlay';
  sheet.style.display = 'flex';
  sheet.innerHTML = '<div class="modal-box new-task-box" role="dialog" aria-modal="true" aria-labelledby="newTaskTitle">'
    + '<div class="modal-title" id="newTaskTitle">New task</div>'
    + '<div class="modal-desc">Choose a project to start a session in.</div>'
    + (rows ? '<div class="new-task-list">' + rows + '</div>'
      : '<div class="new-task-empty">No recent projects. Open a device to pick a project.</div>')
    + '<div class="modal-actions"><button class="modal-btn cancel" type="button">Cancel</button></div></div>';
  sheet.addEventListener('click', event => {
    if (event.target === sheet || event.target.closest('.cancel')) {
      closeNewTaskSheet();
      return;
    }
    const row = event.target.closest('.recent-project[data-phash]');
    if (!row) return;
    closeNewTaskSheet();
    startNewSessionIn(row.dataset.device, row.dataset.phash, row.dataset.pname);
  });
  document.body.appendChild(sheet);
  document.addEventListener('keydown', onNewTaskKeydown, true);
  sheet.querySelector('.recent-project, .cancel')?.focus();
}

function onMoreMenuKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeTopMoreMenu();
}

export function closeTopMoreMenu() {
  document.getElementById('topMoreMenu')?.remove();
  document.removeEventListener('keydown', onMoreMenuKeydown, true);
}

// Narrow headers fold the workspace buttons into one menu that forwards to the real buttons.
export function openTopMoreMenu(button) {
  closeTopMoreMenu();
  const actions = [...document.querySelectorAll('#top-right > .project-files-entry')];
  if (!actions.length) return;
  const rect = button.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.id = 'topMoreMenu';
  overlay.className = 'modal-overlay top-more-overlay';
  overlay.style.display = 'block';
  overlay.innerHTML = '<div class="top-more-menu" role="menu" style="top:' + layoutPixels(rect.bottom + 4) + 'px;right:'
    + layoutPixels(Math.max(8, window.innerWidth - rect.right)) + 'px">'
    + actions.map((action, index) => '<button class="top-more-item" type="button" role="menuitem" data-index="' + index + '">'
      + action.innerHTML + '<span>' + esc(action.title || action.getAttribute('aria-label') || '') + '</span></button>').join('')
    + '</div><button class="cancel" type="button" hidden>Close</button>';
  overlay.addEventListener('click', event => {
    const item = event.target.closest('.top-more-item');
    closeTopMoreMenu();
    if (item) actions[Number(item.dataset.index)]?.click();
  });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onMoreMenuKeydown, true);
  overlay.querySelector('.top-more-item')?.focus();
}

export function toggleSidebar(show) {
  const collapsed = show === undefined
    ? !document.documentElement.classList.contains('sidebar-collapsed')
    : !show;
  document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch {}
}

Object.assign(window, {
  sessionPinButton, toggleCurrentPin, startNewSessionIn, openProjectReview,
  openNewTaskSheet, closeNewTaskSheet, toggleSidebar, openTopMoreMenu, closeTopMoreMenu,
});
