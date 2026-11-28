import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = new Map([
  ['agents', readFileSync(new URL('../../../AGENTS.md', import.meta.url), 'utf8')],
  ['push', readFileSync(new URL('../../../docs/deployment/PUSH-DEPLOYMENT.sdoc', import.meta.url), 'utf8')],
  ['deployment', readFileSync(new URL('../../../docs/deployment/DEPLOYMENT-REFERENCE.sdoc', import.meta.url), 'utf8')],
  ['ios', readFileSync(new URL('../../../docs/deployment/IOS-CLIENT.sdoc', import.meta.url), 'utf8')],
  ['iac', readFileSync(new URL('../../../docs/deployment/IAC.sdoc', import.meta.url), 'utf8')],
]);

test('deployment guidance names the push-only controller and removes retired updater authority', () => {
  assert.match(files.get('agents'), /sole backend delivery path is GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet/u);
  assert.doesNotMatch(files.get('agents'), /exclusive updater/u);
});

test('push deployment distinguishes approved first activation from image-only update', () => {
  const push = files.get('push');
  assert.match(push, /First application activation/u);
  assert.match(push, /For an image-only update, the Ansible `deploy` stage requires a running, healthy Full API/u);
  assert.doesNotMatch(push, /The Ansible `deploy` stage requires a running, healthy Full API under the `codexia` rootless account\./u);
  assert.match(push, /`auth-runtime` before `deploy`/u);
  assert.match(push, /before starting the API, `deploy` verifies the exact application migration ledger/u);
  assert.doesNotMatch(push, /current production job is an image-update path, not a fresh VM initializer/u);
});

test('deployment and iOS docs distinguish explicit access-token revocation from logout', () => {
  for (const key of ['deployment', 'ios']) {
    const body = files.get(key);
    assert.match(body, /oauth2\/revoke/u);
    assert.match(body, /(?:logout|Sign-out).*does not revoke.*already-issued.*access/u);
    assert.doesNotMatch(body, /individual (?:JWT|token) revocation is unsupported/u);
  }
});

test('IAC retains the explicit staged deployment and authentication boundary', () => {
  const iac = files.get('iac');
  assert.match(iac, /`bootstrap` runs `host`, `secrets`, `base`, and the approved `auth-runtime` tasks in order/u);
  assert.match(iac, /initializes the application schema.*before provisioning the auth schema/u);
  assert.match(iac, /pristine-schema first activation or certified image update, with verified encrypted backup for the update/u);
});
