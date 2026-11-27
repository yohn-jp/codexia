const TRACE_TEST_SOURCE = /(?:^|[./-])(?:test|spec|browser)(?:-[a-z0-9]+)?\.[cm]?[jt]sx?$/u;

export function isTraceTestSource(file) {
  return typeof file === 'string' && TRACE_TEST_SOURCE.test(file);
}
