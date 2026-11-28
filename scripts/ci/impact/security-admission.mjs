#!/usr/bin/env node
// A single, fail-closed PR scan admission policy shared by CodeQL and Trivy.
// Git history scanning (Gitleaks), main and scheduled checks are not affected.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isOpenApiGenerationInput } from './contract.mjs';

const sha = /^[0-9a-f]{40}$/u;
const compiledCode = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx|vue|svelte|html)$/iu;
const dependency = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[^/]+)?\.json|\.npmrc|\.pnp\..*|bun\.lockb?|yarn\.lock)$/iu;
const codeqlConfiguration = /^(?:\.github\/codeql\/|\.github\/workflows\/codeql\.yml$|\.codeql\/|codeql\.)/u;
const nativeSource = /^ios\/(?:CodexiaTransport|CodexiaApp|CodexiaEditor)\//u;
const ignoredText = /^(?:docs\/.*\.(?:md|sdoc|sgra|mmd)|README(?:\.[^/]+)?\.md|AGENTS\.md|CONTRIBUTING\.md|LICENSE)$/iu;
const knownNotCodeql = /\.(?:swift|pbxproj|xcscheme|entitlements|xcconfig|plist|py|sh|sql|md|mdx|css|scss|svg|png|jpe?g|webp|gif|ico|lock|toml|yaml|yml|json|tf|hcl|txt|gra)$/iu;
const trivySourceRoots = /^(?:app\/src\/|modules\/[^/]+\/src\/|packages\/[^/]+\/src\/|packages\/[^/]+\/test\/|packages\/[^/]+\/tests\/|scripts\/|tests\/|ios\/)/u;
const codeSource = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx|swift|css|scss|html|svg)$/iu;

export function codeqlInput(file) {
  if (compiledCode.test(file) || dependency.test(file) || codeqlConfiguration.test(file) || isOpenApiGenerationInput(file)) return true;
  if (/^(?:Dockerfile|Containerfile)[^/]*$/iu.test(file) || /(?:^|\/)(?:Dockerfile|Containerfile)[^/]*$/iu.test(file)) return false;
  if (ignoredText.test(file) || knownNotCodeql.test(file) || file === '.gitignore') return false;
  // Unknown file kinds may be analyzer inputs or change the extraction policy.
  return true;
}

export function trivyInput(file) {
  if (ignoredText.test(file)) return false;
  if (dependency.test(file) || /(?:^|\/)(?:Dockerfile[^/]*|Containerfile[^/]*|requirements[^/]*|Cargo\.lock|Cargo\.toml|go\.(?:mod|sum)|pyproject\.toml|Pipfile(?:\.lock)?|Package\.(?:swift|resolved))$/iu.test(file)) return true;
  if (file.startsWith('.github/') || file.startsWith('deploy/') ||
      /(?:^|\/)(?:\.trivyignore(?:\.yaml)?|\.gitleaks\.toml|\.gitleaksignore)$/iu.test(file)) return true;
  if (/\.(?:yml|yaml|json|tf|tfvars|hcl|toml|lock|dockerignore)$/iu.test(file)) return true;
  if (trivySourceRoots.test(file) && codeSource.test(file)) return false;
  if (nativeSource.test(file) && /\.(?:pbxproj|xcscheme|entitlements|xcconfig|plist)$/iu.test(file)) return false;
  // Never skip filesystem scanning for an unfamiliar extension or new root.
  return true;
}

export function selectScanAdmission(files, event = 'pull_request') {
  if (event !== 'pull_request' || !Array.isArray(files) ||
      files.some(f => typeof f !== 'string' || !f || f.startsWith('/') ||
        f.includes('\\') || f.split('/').includes('..'))) {
    return { codeql: true, trivy: true, reason: 'main, scheduled, invalid or unavailable PR diff' };
  }
  return {
    codeql: files.some(codeqlInput),
    trivy: files.some(trivyInput),
    reason: 'exact merged-tree delta against the PR base',
  };
}

export function exactPullRequestFiles({ base, head, checkoutSha, runGit = (...args) => execFileSync('git', args, { encoding: 'utf8' }) }) {
  if (![base, head, checkoutSha].every(s => sha.test(s ?? ''))) throw new Error('Missing exact PR identity');
  const parents = runGit('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/u);
  if (parents.length !== 3 || parents[0] !== checkoutSha || parents[1] !== base || parents[2] !== head) {
    throw new Error('Checkout is not the exact two-parent PR merge result');
  }
  return runGit('diff', '--name-only', '--no-renames', '-z', base, checkoutSha).split('\0').filter(Boolean);
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
      console.log('PR scan scope unavailable; scan conservatively: ' + String(error.message));
    }
  }
  const choice = selectScanAdmission(files, event);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      'codeql=' + choice.codeql + '\ntrivy=' + choice.trivy + '\n');
  }
  const summary = 'Exact-source security admission: CodeQL ' +
    (choice.codeql ? 'SELECTED' : 'NOT_SELECTED') + ', Trivy ' +
    (choice.trivy ? 'SELECTED' : 'NOT_SELECTED') + ' (' + choice.reason + ').\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
