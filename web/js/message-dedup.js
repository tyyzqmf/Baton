function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  const block = message.content.find((item) => item?.type === 'text');
  return block?.text || '';
}

function isCodexContextText(text) {
  const value = String(text || '').trim();
  const externalContext = /^<external_([^>]+)>[\s\S]*<\/external_\1>$/.test(value);
  return /^# AGENTS\.md instructions[\s\S]*<\/INSTRUCTIONS>$/i.test(value)
    || /^<environment_context>[\s\S]*<\/environment_context>$/i.test(value)
    || externalContext
    || /^<skill>[\s\S]*<\/skill>$/i.test(value)
    || /^<user_shell_command>[\s\S]*<\/user_shell_command>$/i.test(value)
    || /^<turn_aborted>[\s\S]*<\/turn_aborted>$/i.test(value)
    || /^<subagent_notification>[\s\S]*<\/subagent_notification>$/i.test(value)
    || /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/i
      .test(value)
    || /^<goal_context>[\s\S]*<\/goal_context>$/i.test(value)
    || /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/i.test(value)
    || /^<hook_prompt hook_run_id="[^"]+">[\s\S]*<\/hook_prompt>$/.test(value)
    || value.startsWith(
      'Warning: The maximum number of unified exec processes you can keep open is',
    )
    || (
      value.startsWith('Warning: apply_patch was requested via ')
      && value.endsWith('Use the apply_patch tool instead of exec_command.')
    )
    || value.startsWith(
      'Warning: Your account was flagged for potentially high-risk cyber activity',
    );
}

export function isCodexContextMessage(message) {
  if (message?.type !== 'user') return false;
  const nativeId = String(message.nativeId || '');
  const uuid = String(message.uuid || '');
  const codexOwned = nativeId.startsWith('codex:')
    || uuid.startsWith('codex:')
    || uuid.startsWith('codex_');
  const texts = typeof message.content === 'string'
    ? [message.content]
    : (message.content || [])
      .filter((item) => item?.type === 'text')
      .map((item) => item.text || '');
  return codexOwned && texts.some(isCodexContextText);
}

function codexUserIdentity(nativeId) {
  const value = String(nativeId || '');
  if (/^codex:turn:.+:user$/.test(value)) return 'turn';
  if (/^codex:user:.+/.test(value)) return 'client';
  return '';
}

function duplicatePair(left, right) {
  if (left?.type !== 'user' || right?.type !== 'user') return false;
  const leftKind = codexUserIdentity(left.nativeId);
  const rightKind = codexUserIdentity(right.nativeId);
  if (!leftKind || !rightKind || leftKind === rightKind) return false;
  if (messageText(left).trim() !== messageText(right).trim()) return false;
  const leftAt = Date.parse(left.timestamp || '');
  const rightAt = Date.parse(right.timestamp || '');
  return Number.isFinite(leftAt) && Number.isFinite(rightAt)
    && Math.abs(leftAt - rightAt) <= 100;
}

export function dedupeCodexUserMessages(messages) {
  const output = [];
  for (const message of messages || []) {
    if (isCodexContextMessage(message)) continue;
    let duplicateIndex = -1;
    for (let index = output.length - 1; index >= 0 && index >= output.length - 3; index--) {
      if (duplicatePair(output[index], message)) {
        duplicateIndex = index;
        break;
      }
    }
    if (duplicateIndex === -1) {
      output.push(message);
      continue;
    }
    // The client-scoped event is canonical: its identity matches send acks and
    // stream anchors, while the turn-scoped row is Codex's earlier mirror.
    if (codexUserIdentity(message.nativeId) === 'client') {
      output[duplicateIndex] = message;
    }
  }
  return output;
}
