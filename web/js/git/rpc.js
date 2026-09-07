import { state } from '../state.js';
import { assembleTextFrames, requestWsRpc } from '../ws-rpc.js';

function assembleSnapshot(frames) {
  var groups = { conflicts: [], staged: [], changes: [] };
  frames.forEach(function (frame) {
    Object.keys(groups).forEach(function (group) {
      groups[group] = groups[group].concat(frame.groups?.[group] || []);
    });
  });
  return { ...frames[frames.length - 1], groups: groups };
}

export function requestGit(operation, fields, options) {
  return requestWsRpc({
    action: 'git_status',
    operation: operation,
    projectHash: fields.projectHash,
    device: state.appState.device || '',
    ...(fields.group ? { group: fields.group } : {}),
    ...(fields.path ? { path: fields.path } : {}),
    ...(fields.all ? { all: true } : {}),
    ...(fields.snapshotId ? { snapshotId: fields.snapshotId } : {}),
    ...(fields.diffToken ? { diffToken: fields.diffToken } : {}),
    ...(fields.cursor ? { cursor: fields.cursor } : {}),
  }, {
    ...(options || {}),
    assemble: operation === 'diff' ? assembleTextFrames : assembleSnapshot,
  });
}

export async function requestGitDiff(fields) {
  var content = '';
  var next = { ...fields };
  var result;
  for (var page = 0; page < 20; page++) {
    result = await requestGit('diff', next, { timeout: 30000 });
    content += result.content || '';
    if (result.diffComplete || !result.nextCursor) break;
    next = {
      ...fields,
      diffToken: result.diffToken,
      cursor: result.nextCursor,
    };
  }
  return { ...result, content: content };
}
