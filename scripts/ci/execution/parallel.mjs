// Bounded execution with exclusive barriers. A rejected sibling never cancels the rest.
export async function runBounded(items, execute, { limit = 2, exclusive = () => false } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit');
  const results = new Array(items.length);
  async function settle(index) {
    try { results[index] = { status: 'fulfilled', value: await execute(items[index], index) }; }
    catch (reason) { results[index] = { status: 'rejected', reason }; }
  }
  let offset = 0;
  while (offset < items.length) {
    if (exclusive(items[offset])) { await settle(offset++); continue; }
    let end = offset;
    while (end < items.length && !exclusive(items[end])) end++;
    let cursor = offset;
    await Promise.all(Array.from({ length: Math.min(limit, end - offset) }, async () => {
      while (cursor < end) await settle(cursor++);
    }));
    offset = end;
  }
  return results;
}

export async function runDependencyBuilds(targets, dependenciesOf, build, limit = 2) {
  const pending = new Set(targets);
  const results = new Map();
  while (pending.size) {
    const ready = [...pending].filter(id => dependenciesOf(id).every(dep => results.has(dep)));
    if (!ready.length) throw new Error('Unresolved workspace build dependency');
    const settled = await runBounded(ready, async id => {
      const failed = dependenciesOf(id).filter(dep => results.get(dep).status !== 'passed');
      if (failed.length) return { status: 'blocked', error: 'Failed prerequisites: ' + failed.join(', ') };
      await build(id);
      return { status: 'passed' };
    }, { limit });
    ready.forEach((id, i) => {
      const result = settled[i];
      results.set(id, result.status === 'fulfilled' ? result.value : { status: 'failed', error: String(result.reason) });
      pending.delete(id);
    });
  }
  return results;
}
