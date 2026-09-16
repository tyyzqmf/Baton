import { codexArchives } from './codex-archive.mjs';
import { codexInteraction } from './codex-interaction.mjs';
import { scanCodexRollout } from './codex-session.mjs';
import { projectHashFromCwd, storageSessionId } from './session-identity.mjs';
import { CLAUDE_PROJECTS } from './config.mjs';
import { postRequired } from './http.mjs';
import { safeCodexArchivePath } from './codex-archive-index.mjs';

export async function startCodexArchives(config) {
  codexArchives.isBusy = (id) => codexInteraction.isBusy(id);
  codexArchives.busySessionIds = () => [...codexInteraction.sessions.keys()].filter((id) => codexInteraction.isBusy(id));
  codexArchives.sync = async (records) => {
    const acknowledged = [];
    const conflicts = [];
    for (let offset = 0; offset < records.length; offset += 100) {
      const observations = [];
      const sessions = [];
      for (const record of records.slice(offset, offset + 100)) {
        let session;
        try {
          const filePath = safeCodexArchivePath(record.home, record.path);
          session = filePath ? scanCodexRollout(filePath, { nativeSessionId: record.id }).session : null;
        } catch {}
        if (!session && record.cwd && record.preview) {
          session = {
            id: record.id, nativeSessionId: record.id, runtime: 'codex',
            project: projectHashFromCwd(record.cwd, CLAUDE_PROJECTS),
            projectName: record.cwd, preview: record.preview,
            lastActive: record.lastActive || new Date(record.archiveVersion).toISOString(),
            status: record.status?.type === 'active' ? 'running' : 'completed',
            ...(record.parentThreadId ? {
              parentSessionId: storageSessionId('codex', record.parentThreadId),
              threadKind: 'subagent', isAgent: true,
            } : {}),
          };
        }
        if (!session) continue;
        const { _filePath, _lineCount, archiveState, ...metadata } = session;
        sessions.push(metadata);
        observations.push({
          sessionId: storageSessionId('codex', record.id),
          projectHash: session.project,
          archiveState: record.archiveState,
          archiveVersion: record.archiveVersion,
        });
      }
      if (!sessions.length) continue;
      await postRequired('/api/bridge/sync-sessions', {
        deviceName: config.deviceName, os: process.platform,
        catalogComplete: false, sessions,
      });
      const response = await postRequired('/api/bridge/sync-archives', { deviceName: config.deviceName, observations });
      const result = await response.json();
      if (!Array.isArray(result.acknowledged)) throw new Error('Server does not acknowledge archive observations.');
      for (const record of records.slice(offset, offset + 100)) {
        const sessionId = storageSessionId('codex', record.id);
        if (result.acknowledged.some((item) => item.sessionId === sessionId
          && item.archiveState === record.archiveState && item.archiveVersion === record.archiveVersion)) {
          acknowledged.push(`${record.home}:${record.id}`);
        }
        const conflict = result.ignored?.find((item) => item.sessionId === sessionId);
        if (conflict) conflicts.push({ home: record.home, id: record.id, version: conflict.currentArchiveVersion });
      }
    }
    return { acknowledged, conflicts };
  };
  await codexArchives.start();
}
