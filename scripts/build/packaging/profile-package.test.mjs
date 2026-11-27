import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuildCommands, validateProfilePackage } from './profile-package.mjs';

test('Core package depends on the API and builds no optional module package', () => {
  const profile = { profile: 'core', modules: [] };
  const packageManifest = {
    name: '@codexia/profile-core',
    dependencies: {
      '@codexia/api': 'workspace:*',
      '@codexia/persistence-postgres': 'workspace:*',
    },
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
  assert.equal(frontendCommands.some(({ args }) => args.includes('@codexia/persistence-postgres')), false);
});

test('Full package waits for selected module producers and exact package dependencies', () => {
  const profile = { profile: 'full', modules: ['story', 'semantic', 'search'] };
  const packageManifest = {
    name: '@codexia/profile-full',
    dependencies: {
      '@codexia/api': 'workspace:*',
      '@codexia/persistence-postgres': 'workspace:*',
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
    () => validateProfilePackage('full', profile, {
      ...packageManifest,
      dependencies: {
        '@codexia/api': 'workspace:*',
        '@codexia/persistence-postgres': 'workspace:*',
        '@codexia/module-story': 'workspace:*',
      },
    }, new Set(['story', 'semantic', 'search'])),
    /dependencies do not match/u,
  );
  assert.throws(
    () => validateProfilePackage('full', profile, {
      ...packageManifest,
      dependencies: Object.fromEntries(Object.entries(packageManifest.dependencies)
        .filter(([name]) => name !== '@codexia/persistence-postgres')),
    }, new Set(['story', 'semantic', 'search'])),
    /must depend on @codexia\/persistence-postgres/u,
  );

  const commands = createBuildCommands('full', profile);
  const moduleBuild = commands.find(({ args }) => args.includes('build') && args.some((argument) => argument.includes('@codexia/module-story')));
  assert.ok(moduleBuild);
  assert.ok(moduleBuild.args.includes('@codexia/module-semantic...'));
  assert.ok(moduleBuild.args.includes('@codexia/module-search...'));
});

// Exercise the observable command boundary: a shared dependency closure is
// requested once and generation runs only after its producer has completed.
test('profile packaging requests one topological workspace build before generation', () => {
  for (const profileName of ['core', 'full']) {
    const profile = { profile: profileName, modules: profileName === 'full' ? ['story', 'semantic'] : [] };
    const commands = createBuildCommands(profileName, profile);
    const producers = commands.filter(({ command, args }) => command === 'pnpm' && args.includes('--recursive'));
    assert.equal(producers.length, 1);
    assert.equal(commands[0], producers[0]);
    assert.ok(producers[0].args.includes('--sort'));
    const apiFilter = producers[0].args.indexOf('@codexia/api...');
    assert.ok(apiFilter > 0);
    assert.equal(producers[0].args[apiFilter - 1], '--filter-prod');
    assert.ok(commands[1].args.some(arg => arg.endsWith('profile-build.mjs')));
    assert.equal(commands[2].env.CODEXIA_PROFILE, profileName);
  }
});
