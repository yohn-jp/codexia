import path from 'node:path';

export default async function* reportCases(events) {
  for await (const { type, data } of events) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type !== 'test' || !data.file || !Number.isSafeInteger(data.line) || data.name === data.file) continue;
    let result = type === 'test:pass' ? 'PASSED' : 'FAILED';
    if (Object.hasOwn(data, 'skip') && data.skip !== false) result = 'SKIPPED';
    else if (Object.hasOwn(data, 'todo') && data.todo !== false) result = 'TODO';
    yield JSON.stringify({
      name: data.name, file: path.relative(process.cwd(), data.file).split(path.sep).join('/'),
      line: data.line, result,
    }) + '\n';
  }
}

export function associateTraceCases(scenarios, cases) {
  const casesByName = Map.groupBy(cases, item => item.name);
  return scenarios.map(scenario => {
    const files = (scenario.RELATIONS ?? []).filter(relation => relation.TYPE === 'File');
    const matches = (casesByName.get(scenario['Case name']) ?? []).filter(item => files.some(relation => {
      if ((relation.VALUE ?? relation.PATH) !== item.file) return false;
      if (relation.LINE_RANGE === undefined) return true;
      const [start, end] = String(relation.LINE_RANGE).split(',').map(Number);
      return item.line >= start && item.line <= end;
    }));
    if (matches.length !== 1) {
      return { testId: scenario.UID, result: matches.length > 1 ? 'AMBIGUOUS' : 'NOT_RUN' };
    }
    return { testId: scenario.UID, ...matches[0] };
  });
}
