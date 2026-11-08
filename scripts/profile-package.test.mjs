import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuildCommands, validateProfilePackage } from './profile-package.mjs';

test('Core package depends on the API and builds no optional module package', () => {
  const profile = { profile: 'core', modules: [] };
  const packageManifest = {
    name: '@codexia/profile-core',
    dependencies: { '@codexia/api': 'workspace:*' },
  };
  assert.deepEqual(validateProfilePackage('core', profile, packageManifest, new Set()), {
    profileName: 'core',
    moduleIds: [],
  });

  const commands = createBuildCommands('core', profile);
  assert.equal(
    commands.some(({ args }) => args.some((argument) =>
      argument.startsWith('@codexia/module-') && argument !== '@codexia/module-runtime')),
    false,
  );
  assert.deepEqual(commands.find(({ args }) => args.includes('@codexia/app'))?.env, { CODEXIA_PROFILE: 'core' });

  const backendCommands = createBuildCommands('core', profile, { includeUi: false });
  assert.equal(backendCommands.some(({ args }) => args.includes('@codexia/app')), false);
  assert.equal(backendCommands.some(({ args }) => args.some((argument) => argument.includes('@codexia/api'))), true);

  const frontendCommands = createBuildCommands('core', profile, { includeApi: false });
  assert.equal(frontendCommands.some(({ args }) => args.some((argument) => argument.includes('@codexia/api'))), false);
  assert.equal(frontendCommands.some(({ args }) => args.includes('@codexia/app')), true);
});

test('Full package waits for selected module producers and exact package dependencies', () => {
  const profile = { profile: 'full', modules: ['story', 'semantic', 'search'] };
  const packageManifest = {
    name: '@codexia/profile-full',
    dependencies: {
      '@codexia/api': 'workspace:*',
      '@codexia/module-story': 'workspace:*',
      '@codexia/module-semantic': 'workspace:*',
      '@codexia/module-search': 'workspace:*',
    },
  };
  assert.deepEqual(validateProfilePackage('full', profile, packageManifest, new Set(['story', 'semantic', 'search'])), {
    profileName: 'full',
    moduleIds: ['story', 'semantic', 'search'],
  });
  assert.throws(
    () => validateProfilePackage('full', profile, packageManifest, new Set(['story', 'semantic'])),
    /not been produced: search/u,
  );
  assert.throws(
    () => validateProfilePackage('full', profile, { ...packageManifest, dependencies: { '@codexia/api': 'workspace:*', '@codexia/module-story': 'workspace:*' } }, new Set(['story', 'semantic', 'search'])),
    /dependencies do not match/u,
  );

  const commands = createBuildCommands('full', profile);
  const moduleBuild = commands.find(({ args }) => args.includes('build') && args.some((argument) => argument.includes('@codexia/module-story')));
  assert.ok(moduleBuild);
  assert.ok(moduleBuild.args.includes('@codexia/module-semantic...'));
  assert.ok(moduleBuild.args.includes('@codexia/module-search...'));
});
