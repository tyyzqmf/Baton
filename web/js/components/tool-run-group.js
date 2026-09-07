// Shared grouping behavior for consecutive tool nodes with the same UI shape.
(function () {
  const configs = new Map();
  const collapsedState = new Map();

  function className(config, suffix) {
    return `${config.classPrefix}-${suffix}`;
  }

  function groupStateKey(config, item) {
    const toolId = item?.dataset?.toolId || '';
    return toolId ? `${config.kind}:${toolId}` : '';
  }

  function groupMembers(root, groupId) {
    return Array.from(root.querySelectorAll('[data-tool-details-group]'))
      .filter((item) => item.dataset.toolDetailsGroup === groupId);
  }

  function resetItem(config, item) {
    item.querySelector(
      `:scope > .tool-header > .${className(config, 'group-count')}`,
    )?.remove();
    item.classList.remove(
      'tool-run-continuation',
      'tool-run-group-start',
      'tool-run-group-connected',
      'tool-run-group-collapsed',
      'tool-run-group-hidden',
      'tool-run-summary-normal',
      'tool-run-summary-error',
      'tool-run-summary-warning',
      className(config, 'continuation'),
      className(config, 'group-start'),
      className(config, 'group-connected'),
      className(config, 'group-collapsed'),
      className(config, 'group-hidden'),
    );
    item.parentElement?.classList.remove(
      'tool-run-row-hidden',
      className(config, 'row-hidden'),
    );
    delete item.dataset.toolDetailsGroup;
    delete item.dataset.toolRunKind;
  }

  function setCollapsed(groupId, collapsed, root = document) {
    if (!groupId) return;
    const members = groupMembers(root, groupId);
    if (members.length < 2) return;
    const config = configs.get(members[0].dataset.toolRunKind || '');
    if (!config) return;

    const first = members[0];
    const latest = members.at(-1);
    const stateKey = groupStateKey(config, first);
    if (stateKey) collapsedState.set(stateKey, collapsed);
    first.classList.toggle('tool-run-group-collapsed', collapsed);
    first.classList.toggle(className(config, 'group-collapsed'), collapsed);
    first.classList.remove(
      'tool-run-summary-normal',
      'tool-run-summary-error',
      'tool-run-summary-warning',
    );
    if (collapsed) {
      first.classList.add(
        latest.classList.contains('error')
          ? 'tool-run-summary-error'
          : latest.classList.contains('warning')
            ? 'tool-run-summary-warning'
            : 'tool-run-summary-normal',
      );
    }
    for (let index = 1; index < members.length; index++) {
      members[index].classList.toggle('tool-run-group-hidden', collapsed);
      members[index].classList.toggle(className(config, 'group-hidden'), collapsed);
    }

    const rows = new Set(members.map((item) => item.parentElement).filter(Boolean));
    for (const row of rows) {
      const children = Array.from(row.children);
      row.classList.toggle(
        'tool-run-row-hidden',
        children.length > 0
          && children.every((item) =>
            item.classList.contains('tool-run-group-hidden')),
      );
      row.classList.toggle(
        className(config, 'row-hidden'),
        children.length > 0
          && children.every((item) =>
            item.classList.contains(className(config, 'group-hidden'))),
      );
    }
  }

  function markConfig(container, config) {
    let assistantRows = [];
    let sequence = 0;
    const priorCollapsed = new Map();
    for (const start of container.querySelectorAll(
      `.${className(config, 'group-start')}`,
    )) {
      const stateKey = groupStateKey(config, start);
      if (stateKey) {
        priorCollapsed.set(
          stateKey,
          start.classList.contains(className(config, 'group-collapsed')),
        );
      }
    }

    const flushRows = () => {
      if (!assistantRows.length) return;
      const items = assistantRows.flatMap((row) => Array.from(row.children));
      for (const item of items) {
        if (item.classList.contains(config.itemClass)) resetItem(config, item);
      }

      for (let start = 0; start < items.length;) {
        const isEligible = (item) => item.classList.contains(config.itemClass);
        if (!isEligible(items[start])) {
          start++;
          continue;
        }
        let end = start + 1;
        while (end < items.length && isEligible(items[end])) {
          end++;
        }
        if (end - start > 1) {
          const members = items.slice(start, end);
          const first = members[0];
          const groupId = `${config.kind}-${sequence++}`;
          const stateKey = groupStateKey(config, first);
          const savedState = stateKey && collapsedState.has(stateKey)
            ? collapsedState.get(stateKey)
            : priorCollapsed.get(stateKey);
          const collapsed = savedState !== undefined
            ? savedState
            : members.every((item) =>
              item.classList.contains('tool-details-collapsed'));

          first.classList.add(
            'tool-run-group-start',
            className(config, 'group-start'),
          );
          for (let index = 1; index < members.length; index++) {
            members[index].classList.add(
              'tool-run-continuation',
              className(config, 'continuation'),
            );
          }
          for (const member of members) {
            member.dataset.toolDetailsGroup = groupId;
            member.dataset.toolRunKind = config.kind;
            window.setToolDetailsCollapsed?.(member, collapsed);
          }
          if (end < items.length) {
            for (const member of members) {
              member.classList.add(
                'tool-run-group-connected',
                className(config, 'group-connected'),
              );
            }
          }

          const count = document.createElement('span');
          count.className = `tool-run-group-count ${className(config, 'group-count')}`;
          count.textContent = `×${members.length}`;
          first.querySelector(':scope > .tool-header > .tool-name')?.after(count);
          setCollapsed(groupId, collapsed, container);
        }
        start = end;
      }
      assistantRows = [];
    };

    for (const row of container.children) {
      if (row.classList?.contains('assistant-turn')) assistantRows.push(row);
      else flushRows();
    }
    flushRows();
  }

  window.registerToolRunGroup = function (config) {
    if (!config?.kind || !config.itemClass || !config.classPrefix) return false;
    configs.set(config.kind, { ...config });
    return true;
  };

  window.markToolRunGroups = function (container) {
    if (!container) return;
    for (const config of configs.values()) markConfig(container, config);
  };

  window.setToolRunGroupCollapsed = setCollapsed;

  window.resetToolRunGroupState = function () {
    collapsedState.clear();
  };
})();
