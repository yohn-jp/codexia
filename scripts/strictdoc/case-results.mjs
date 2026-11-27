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

export function associateTraceCases(testSources, cases) {
  const casesByLocation = Map.groupBy(cases, item => `${item.file}\0${item.line}`);
  return [...testSources].map(([testId, { name, file, line }]) => {
    const sourceRefs = [{ path: file, line }];
    const matches = (casesByLocation.get(`${file}\0${line}`) ?? []).filter(item => item.name === name);
    if (matches.length !== 1) {
      return { testId, name, sourceRefs, result: matches.length > 1 ? 'AMBIGUOUS' : 'NOT_RUN' };
    }
    return { testId, sourceRefs, ...matches[0] };
  });
}
