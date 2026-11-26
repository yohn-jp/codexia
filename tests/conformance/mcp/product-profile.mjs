// Applicability rules for the pinned 2026-07-28 official conformance suite.
// Keep native outcomes. Only documented, observed feature absence can be inapplicable.
const rules = new Map();
function rule(scenario, id, status, error) {
  const list = rules.get(scenario) ?? [];
  list.push({ id, status, error });
  rules.set(scenario, list);
}
for (const scenario of ['completion-complete', 'resources-list', 'resources-read-text', 'resources-read-binary', 'resources-templates-read', 'prompts-list', 'prompts-get-simple', 'prompts-get-with-args', 'prompts-get-embedded-resource', 'prompts-get-with-image']) {
  rule(scenario, scenario, 'FAILURE', 'Failed: Method not found');
}
for (const [scenario, tool] of Object.entries({
  'tools-call-simple-text': 'test_simple_text',
  'tools-call-image': 'test_image_content',
  'tools-call-audio': 'test_audio_content',
  'tools-call-embedded-resource': 'test_embedded_resource',
  'tools-call-mixed-content': 'test_multiple_content_types',
  'tools-call-error': 'test_error_handling',
  'tools-call-with-progress': 'test_tool_with_progress',
})) rule(scenario, scenario, 'FAILURE', 'Failed: Tool ' + tool + ' not found');
for (const [id, error] of Object.entries({
  'sep-2575-server-rejects-undeclared-capability': "Not testable: server does not list the diagnostic tool 'test_missing_capability' in tools/list and the probe call did not exercise it (required for the undeclared-capability rejection)",
  'sep-2575-missing-capability-http-400': "Not testable: server does not list the diagnostic tool 'test_missing_capability' in tools/list, so the -32021 HTTP status could not be validated",
  'sep-2575-http-server-no-independent-requests-on-stream': "Not testable: server does not list the diagnostic tool 'test_streaming_elicitation' in tools/list, so the response stream could not be exercised",
  'sep-2575-server-no-log-without-loglevel': "Not testable: server does not list the diagnostic tool 'test_logging_tool' in tools/list, so the no-log-without-logLevel requirement could not be exercised",
})) rule('server-stateless', id, 'FAILURE', error);
for (const [id, method] of Object.entries({
  'sep-2549-prompts-list-caching-hints': 'prompts/list',
  'sep-2549-resources-list-caching-hints': 'resources/list',
  'sep-2549-resources-templates-list-caching-hints': 'resources/templates/list',
})) rule('caching', id, 'FAILURE', method + ' returned JSON-RPC error -32601: Method not found');
for (const [suffix, id, tool] of [
  ['basic-elicitation', 'elicitation-incomplete', 'elicitation'],
  ['basic-sampling', 'sampling-incomplete', 'sampling'],
  ['basic-list-roots', 'list-roots-incomplete', 'list_roots'],
  ['request-state', 'request-state-incomplete', 'request_state'],
  ['multiple-input-requests', 'multiple-inputs-incomplete', 'multiple_inputs'],
  ['result-type', 'result-type-included', 'elicitation'],
  ['capability-check', 'respect-client-capabilities', 'capabilities'],
]) rule('input-required-result-' + suffix, 'sep-2322-' + id, 'FAILURE', 'JSON-RPC error: Tool test_input_required_result_' + tool + ' not found');
rule('input-required-result-multi-round', 'sep-2322-multi-round-r1', 'FAILURE', 'Expected InputRequiredResult with inputRequests and requestState');
rule('input-required-result-tampered-state', 'sep-2322-reject-tampered-state', 'FAILURE', 'Prerequisite failed: could not get initial InputRequiredResult with requestState');
rule('input-required-result-non-tool-request', 'sep-2322-non-tool-incomplete', 'FAILURE', 'JSON-RPC error: Method not found');
rule('input-required-result-missing-input-response', 'sep-2322-missing-response-rerequests', 'WARNING', 'Server returned JSON-RPC error instead of re-requesting via InputRequiredResult. SEP-2322 recommends servers re-request missing information.');
rule('input-required-result-ignore-extra-params', 'sep-2322-ignore-unexpected-params', 'WARNING', 'Server returned JSON-RPC error when extra params were included: Tool test_input_required_result_elicitation not found. Servers SHOULD ignore unrecognized information.');

export function evaluateProductProfile(required) {
  const discovery = required.find(item => item.scenario === 'server-stateless');
  const capabilities = discovery?.discoveredCapabilities;
  const tools = discovery?.discoveredToolNames;
  const profileObserved = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) &&
    Object.keys(capabilities).length === 1 && Object.hasOwn(capabilities, 'tools') &&
    Array.isArray(tools) && tools.length > 0 && tools.includes('invoke_action') &&
    tools.every(name => typeof name === 'string' && !name.startsWith('test_')) &&
    ['sep-2575-server-implements-discover', 'sep-2575-discover-capabilities-match-handlers'].every(id =>
      discovery.checks?.some(check => check.id === id && check.status === 'SUCCESS'));
  const results = required.map(item => {
    if (item.status === 'SUCCESS' || item.status === 'SUCCESS_WITH_WARNINGS') {
      return { scenario: item.scenario, outcome: 'PASS', notApplicable: [] };
    }
    const allowed = rules.get(item.scenario) ?? [];
    const checks = item.checks ?? [];
    const matched = checks.filter(check => allowed.some(rule =>
      check.id === rule.id && check.status === rule.status && check.error === rule.error));
    const failures = checks.filter(check => check.status === 'FAILURE');
    const validExit = (item.status === 'FAILURE' && item.exitCode === 1 && failures.length > 0) ||
      (item.status === 'NO_PASSING_CHECK' && item.exitCode === 0 && failures.length === 0);
    const wireValid = item.scenario === 'server-stateless'
      ? checks.some(check => check.id === 'sep-2575-http-server-error-jsonrpc-id' && check.status === 'SUCCESS')
      : checks.some(check => check.id === 'wire-schema-valid' && check.status === 'SUCCESS');
    const unexplained = failures.filter(check => !matched.includes(check));
    const hasHarnessError = checks.some(check => check.id === 'wire-schema-harness-error');
    if (!profileObserved || !validExit || !wireValid || hasHarnessError || !matched.length || unexplained.length) {
      return { scenario: item.scenario, outcome: 'FAIL', notApplicable: [], unexplained: unexplained.map(check => check.id) };
    }
    const behaviorPassed = checks.some(check => check.status === 'SUCCESS' && check.id !== 'wire-schema-valid');
    if (['server-stateless', 'caching'].includes(item.scenario) && !behaviorPassed) {
      return { scenario: item.scenario, outcome: 'FAIL', notApplicable: [] };
    }
    return { scenario: item.scenario, outcome: behaviorPassed ? 'PASS_WITH_NOT_APPLICABLE' : 'NOT_APPLICABLE',
      notApplicable: matched.map(check => ({ id: check.id, nativeStatus: check.status, reason: check.error })) };
  });
  return { profile: 'codexia-tools-only', observed: Boolean(profileObserved), passed: Boolean(profileObserved) &&
    results.length > 0 && results.every(item => item.outcome !== 'FAIL'), results };
}
