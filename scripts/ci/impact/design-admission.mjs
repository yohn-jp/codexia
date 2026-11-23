#!/usr/bin/env node
// Keep stable Impeccable check status while skipping only isolated UI test inputs.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exactPullRequestFiles } from './security-admission.mjs';

export function isDesignFixture(file) {
  if (!/^(?:app\/|modules\/[^/]+\/src\/)/u.test(file)) return false;
  return /(?:^|\/)(?:test|tests)\/|(?:\.test|\.spec)\.[^/]+$/iu.test(file);
}

export function selectDesignAdmission(files, event = 'pull_request') {
  if (event !== 'pull_request' || !Array.isArray(files) ||
      files.some(file => typeof file !== 'string' || !file || file.startsWith('/') ||
        file.includes('\\') || file.split('/').includes('..'))) {
    return { selected: true, reason: 'main, manual, invalid or unavailable PR diff' };
  }
  return {
    selected: files.some(file => !isDesignFixture(file)),
    reason: 'exact merged-tree delta against the PR base',
  };
}

export function main() {
  const event = process.env.GITHUB_EVENT_NAME;
  let files = null;
  if (event === 'pull_request') {
    try {
      files = exactPullRequestFiles({
        base: process.env.CODEXIA_PR_BASE_SHA,
        head: process.env.CODEXIA_PR_HEAD_SHA,
        checkoutSha: process.env.GITHUB_SHA,
      });
    } catch (error) {
      console.log('Design scan scope unavailable; scan conservatively: ' + String(error.message));
    }
  }
  const scope = selectDesignAdmission(files, event);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'design=' + scope.selected + '\n');
  const message = 'Exact-source Impeccable admission: ' + (scope.selected ? 'SELECTED' : 'NOT_SELECTED') +
    ' (' + scope.reason + ').\n';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
