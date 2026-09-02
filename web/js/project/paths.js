export function normalizeProjectPath(value) {
  var output = [];
  String(value || '').replaceAll('\\', '/').split('/').forEach(function (part) {
    if (!part || part === '.') return;
    if (part === '..') output.pop();
    else output.push(part);
  });
  return output.join('/');
}

export function joinProjectPath(parent, child) {
  return normalizeProjectPath((parent ? parent + '/' : '') + child);
}

export function parentProjectPath(value) {
  var parts = normalizeProjectPath(value).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function projectBreadcrumbItems(projectName, value) {
  var items = [{ label: projectName || 'Project', value: '' }];
  var current = '';
  normalizeProjectPath(value).split('/').filter(Boolean).forEach(function (part) {
    current = joinProjectPath(current, part);
    items.push({ label: part, value: current });
  });
  return items;
}
