export function normalizeCodexPlanStatus(status) {
  if (status === 'completed') return 'completed';
  if (status === 'inProgress' || status === 'in_progress') return 'in_progress';
  return 'pending';
}

export function normalizeCodexPlanInput(value = {}) {
  const plan = Array.isArray(value.plan)
    ? value.plan
    : Array.isArray(value.todos)
      ? value.todos
      : [];
  const explanation = typeof value.explanation === 'string'
    ? value.explanation.trim()
    : '';
  return {
    todos: plan.map((item) => ({
      content: String(item?.step || item?.content || ''),
      status: normalizeCodexPlanStatus(item?.status),
    })),
    ...(explanation ? { explanation } : {}),
  };
}

export function codexPlanSignature(value) {
  return JSON.stringify(normalizeCodexPlanInput(value));
}
