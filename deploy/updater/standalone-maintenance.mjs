import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { chmod, lstat, open, readFile, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUpdateChannel } from '../../scripts/update-channel.mjs';
import { matchesRotationCredential } from '../../scripts/rotation-credential-digest.mjs';
import { assertMatchingControllerBackup, validateControllerBackupProof, atomicWrite, clearBackupIntent, loadControllerState, StandaloneController } from '../../scripts/standalone-update-controller.mjs';
import { PodmanStandaloneHost, ensureDirectoryTreeDurable, validatePostgresAppPassword, validateRuntimeContract, validateStandaloneAuthToken, validateStandaloneTunnelToken } from './standalone-host.mjs';
export { validatePostgresAppPassword };
export { validateStandaloneAuthToken };
export function validatePostgresPreflightPassword(content){
  try{return validatePostgresAppPassword(content);}
  catch{throw Error('Invalid protected PostgreSQL preflight password');}
}

export const MAINTENANCE_SOURCE_FILES = Object.freeze([
  'deploy/updater/codexia-updater',
  'deploy/updater/standalone-updater.mjs',
  'deploy/updater/standalone-host.mjs',
  'deploy/updater/standalone-maintenance.mjs',
  'deploy/updater/proxy.mjs',
  'deploy/updater/provision-preflight-role.sql',
  'deploy/updater/standalone-backup.sh',
  'scripts/standalone-schema-maintenance.mjs',
  'scripts/rotation-credential-digest.mjs',
  'scripts/standalone-update-controller.mjs',
  'scripts/update-host-state.mjs',
  'scripts/update-channel.mjs',
  'scripts/update-release-policy.mjs',
]);
export const MAINTENANCE_UNIT_FILES = Object.freeze([
  'codexia-updater-boot.service',
  'codexia-updater.service',
  'codexia-updater.timer',
]);

const probeCredentialNames=Object.freeze({
  githubTokenFile:'github-read-token',
  accessClientIdFile:'access-client-id',
  accessClientSecretFile:'access-client-secret',
});
export function probeCredentialFiles(config,configPath){
  const parent=path.dirname(configPath);
  return Object.entries(probeCredentialNames).map(([key,name])=>{
    const target=path.join(parent,name);
    assert.ok(config[key]===target,'Probe credential must use its canonical private path: '+key);
    return {key,target,candidate:path.join('credentials',name)};
  });
}
export function validateProbeCredential(content){
  // Never include a credential or an assertion diff in an error.
  assert.ok(typeof content==='string'&&Buffer.byteLength(content)<=8192&&/^[!-~]+(?:\n)?$/u.test(content),
    'Invalid protected probe credential');
}
export function validateTunnelToken(content){return validateStandaloneTunnelToken(content);}
export async function assertProbeCredentialAccess(host,state,publicKey){
  try{
    const verified=verifyUpdateChannel(await host.fetchChannel(),publicKey,state.journal.checkpoint);
    assert.ok(verified.payload.releases.some(release=>release.state==='published'&&isDeepStrictEqual(release,state.installed)));
    await host.probeAccessCredentials(state.installed);
  }catch{
    throw Error('Probe credentials did not verify the signed channel and scoped live identity access');
  }
}
function plainObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
export function validateAppPasswordRotationManifest(manifest,manifestPath,serviceHome){
  const keys=['appPasswordFile','candidateRoot','configPath','databaseQuadletFile','format','restoreReceiptFile','rotatePostgresAppPassword','sourceDir','unitDir'];
  assert.ok(plainObject(manifest),'App-password maintenance manifest must be an object');
  assert.deepEqual(Object.keys(manifest).sort(),keys,'Unexpected app-password maintenance manifest fields');
  assert.equal(manifest.format,'codexia-updater-maintenance/v1');
  assert.equal(manifest.rotatePostgresAppPassword,true,'App-password rotation must be explicitly selected');
  for(const key of ['candidateRoot','configPath','sourceDir','unitDir','appPasswordFile','restoreReceiptFile','databaseQuadletFile']){
    assert.ok(typeof manifest[key]==='string'&&path.isAbsolute(manifest[key])&&!/[\r\n\0]/u.test(manifest[key]),
      'App-password maintenance paths must be absolute');
  }
  const candidateRoot=path.resolve(manifest.candidateRoot);
  assert.equal(path.resolve(manifestPath),path.join(candidateRoot,'manifest.json'),'Maintenance manifest must be staged with its candidate');
  assert.equal(path.resolve(manifest.appPasswordFile),path.join(candidateRoot,'credentials','postgres-app-password'),
    'App-password candidate path is outside the fixed private staging location');
  assert.equal(path.resolve(manifest.restoreReceiptFile),path.join(candidateRoot,'restore-receipt.json'),
    'Restore receipt path is outside the fixed private staging location');
  assert.equal(manifest.databaseQuadletFile,path.join(candidateRoot,'quadlet','codexia-db.container'),'Database Quadlet must use its fixed private staging path');
  assert.ok(typeof serviceHome==='string'&&path.isAbsolute(serviceHome),'Service home must be absolute');
  assert.equal(path.dirname(candidateRoot),path.join(serviceHome,'.config','codexia-updater','maintenance','candidates'),
    'App-password candidate must use the private staging root outside the proxy mount');
  assert.equal(path.resolve(manifest.configPath),path.join(serviceHome,'.config','codexia-updater','config.json'),
    'Maintenance may update only the canonical private configuration');
  assert.equal(path.resolve(manifest.unitDir),path.join(serviceHome,'.config','systemd','user'),
    'Maintenance unit directory is outside the service user configuration');
  assert.equal(path.resolve(manifest.sourceDir),'/opt/codexia-updater','Maintenance source directory differs from the canonical installation');
  return {appPasswordFile:manifest.appPasswordFile,restoreReceiptFile:manifest.restoreReceiptFile,databaseQuadletFile:manifest.databaseQuadletFile};
}
export function validatePreflightPasswordRotationManifest(manifest,manifestPath,serviceHome){
  const keys=['candidateRoot','configPath','databaseQuadletFile','format','preflightPasswordFile','restoreReceiptFile','rotatePostgresPreflightPassword','sourceDir','unitDir'];
  assert.ok(plainObject(manifest),'Preflight-password maintenance manifest must be an object');
  assert.deepEqual(Object.keys(manifest).sort(),keys,'Unexpected preflight-password maintenance manifest fields');
  assert.equal(manifest.format,'codexia-updater-maintenance/v1');
  assert.equal(manifest.rotatePostgresPreflightPassword,true,'Preflight-password rotation must be explicitly selected');
  for(const key of ['candidateRoot','configPath','sourceDir','unitDir','preflightPasswordFile','restoreReceiptFile','databaseQuadletFile'])
    assert.ok(typeof manifest[key]==='string'&&path.isAbsolute(manifest[key])&&!/[\r\n\0]/u.test(manifest[key]),
      'Preflight-password maintenance paths must be absolute');
  const candidateRoot=path.resolve(manifest.candidateRoot);
  assert.equal(path.resolve(manifestPath),path.join(candidateRoot,'manifest.json'),'Maintenance manifest must be staged with its candidate');
  assert.equal(path.resolve(manifest.preflightPasswordFile),path.join(candidateRoot,'credentials','postgres-preflight-password'),
    'Preflight-password candidate path is outside the fixed private staging location');
  assert.equal(path.resolve(manifest.restoreReceiptFile),path.join(candidateRoot,'restore-receipt.json'),
    'Restore receipt path is outside the fixed private staging location');
  assert.equal(manifest.databaseQuadletFile,path.join(candidateRoot,'quadlet','codexia-db.container'),
    'Database Quadlet must use its fixed private staging path');
  assert.ok(typeof serviceHome==='string'&&path.isAbsolute(serviceHome),'Service home must be absolute');
  assert.equal(path.dirname(candidateRoot),path.join(serviceHome,'.config','codexia-updater','maintenance','candidates'),
    'Preflight-password candidate must use private staging outside the proxy mount');
  assert.equal(path.resolve(manifest.configPath),path.join(serviceHome,'.config','codexia-updater','config.json'),
    'Maintenance may update only the canonical private configuration');
  assert.equal(path.resolve(manifest.unitDir),path.join(serviceHome,'.config','systemd','user'),
    'Maintenance unit directory is outside the service user configuration');
  assert.equal(path.resolve(manifest.sourceDir),'/opt/codexia-updater','Maintenance source directory differs from the canonical installation');
  return {preflightPasswordFile:manifest.preflightPasswordFile,restoreReceiptFile:manifest.restoreReceiptFile,
    databaseQuadletFile:manifest.databaseQuadletFile};
}
export function validateApiAuthTokenRotationManifest(manifest,manifestPath,serviceHome){
  const keys=['apiAuthTokenFile','candidateRoot','configPath','format','rotateApiAuthToken','sourceDir','unitDir'];
  assert.ok(plainObject(manifest),'API token maintenance manifest must be an object');
  assert.deepEqual(Object.keys(manifest).sort(),keys,'Unexpected API token maintenance manifest fields');
  assert.equal(manifest.format,'codexia-updater-maintenance/v1');
  assert.equal(manifest.rotateApiAuthToken,true,'API token rotation must be explicitly selected');
  for(const key of ['candidateRoot','configPath','sourceDir','unitDir','apiAuthTokenFile'])
    assert.ok(typeof manifest[key]==='string'&&path.isAbsolute(manifest[key])&&!/[\r\n\0]/u.test(manifest[key]),'API token maintenance paths must be absolute');
  const candidateRoot=path.resolve(manifest.candidateRoot);
  assert.equal(path.resolve(manifestPath),path.join(candidateRoot,'manifest.json'),'API token manifest must be staged with its candidate');
  assert.equal(path.resolve(manifest.apiAuthTokenFile),path.join(candidateRoot,'credentials','api-auth-token'),'API token candidate escaped its fixed private staging path');
  assert.equal(path.dirname(candidateRoot),path.join(serviceHome,'.config','codexia-updater','maintenance','candidates'),'API token candidate must use private updater staging');
  assert.equal(path.resolve(manifest.configPath),path.join(serviceHome,'.config','codexia-updater','config.json'),'API token maintenance belongs to another controller');
  assert.equal(path.resolve(manifest.unitDir),path.join(serviceHome,'.config','systemd','user'),'API token maintenance unit path drift');
  assert.equal(path.resolve(manifest.sourceDir),'/opt/codexia-updater','API token maintenance source path drift');
  return {apiAuthTokenFile:manifest.apiAuthTokenFile};
}
export function validateTunnelTokenRotationManifest(manifest,manifestPath,serviceHome){
  const keys=['candidateRoot','configPath','format','rotateTunnelToken','sourceDir','tunnelTokenFile','unitDir'];
  assert.ok(plainObject(manifest),'Tunnel token maintenance manifest must be an object');
  assert.deepEqual(Object.keys(manifest).sort(),keys,'Unexpected Tunnel token maintenance manifest fields');
  assert.equal(manifest.format,'codexia-updater-maintenance/v1');
  assert.equal(manifest.rotateTunnelToken,true,'Tunnel token rotation must be explicitly selected');
  for(const key of ['candidateRoot','configPath','sourceDir','unitDir','tunnelTokenFile'])
    assert.ok(typeof manifest[key]==='string'&&path.isAbsolute(manifest[key])&&!/[\r\n\0]/u.test(manifest[key]),'Tunnel token maintenance paths must be absolute');
  const candidateRoot=path.resolve(manifest.candidateRoot);
  assert.equal(path.resolve(manifestPath),path.join(candidateRoot,'manifest.json'),'Tunnel token manifest must be staged with its candidate');
  assert.equal(path.resolve(manifest.tunnelTokenFile),path.join(candidateRoot,'credentials','tunnel-token'),'Tunnel token candidate escaped its fixed private staging path');
  assert.ok(typeof serviceHome==='string'&&path.isAbsolute(serviceHome),'Service home must be absolute');
  assert.equal(path.dirname(candidateRoot),path.join(serviceHome,'.config','codexia-updater','maintenance','candidates'),'Tunnel token candidate must use private updater staging');
  assert.equal(path.resolve(manifest.configPath),path.join(serviceHome,'.config','codexia-updater','config.json'),'Tunnel token maintenance belongs to another controller');
  assert.equal(path.resolve(manifest.unitDir),path.join(serviceHome,'.config','systemd','user'),'Tunnel token maintenance unit path drift');
  assert.equal(path.resolve(manifest.sourceDir),'/opt/codexia-updater','Tunnel token maintenance source path drift');
  return {tunnelTokenFile:manifest.tunnelTokenFile};
}

const tunnelTokenRotationFormat='codexia-maintenance-tunnel-token/v1';
function assertTunnelTokenRotationState(state){
  assert.ok(['idle','committed'].includes(state.journal.phase)&&!state.initialActivationPending&&state.lastError===null,
    'Tunnel token rotation requires a stable initialized controller');
  assert.equal(state.journal.active.image,state.installed.image,'Committed writer image differs from the installed release');
}
function validateTunnelTokenRotationMarker(marker,config){
  assert.ok(plainObject(marker),'Tunnel token recovery marker must be an object');
  assert.deepEqual(Object.keys(marker).sort(),['configPath','format','operationId','phase','previousTokenFile','routeContent','routeFile','rotation','stateFile','timer'].sort());
  assert.equal(marker.format,tunnelTokenRotationFormat);
  assert.ok(['applying','completed','rolled-back'].includes(marker.phase),'Tunnel token rotation marker phase is invalid');
  timerActivationCommand(marker.timer);
  assert.equal(marker.configPath,path.join(path.dirname(config.publicKeyFile),'config.json'));
  assert.equal(marker.stateFile,config.stateFile);
  assert.equal(marker.routeFile,config.routeFile);
  assert.ok(['blue\n','green\n'].includes(marker.routeContent),'Tunnel rotation route snapshot is invalid');
  assert.match(marker.operationId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  const root=rotationSnapshotRoot(config,marker.operationId);
  assert.equal(path.resolve(marker.previousTokenFile),path.join(root,'tunnel-token'));
  const rotation=marker.rotation;
  assert.ok(plainObject(rotation),'Tunnel token recovery identity is invalid');
  assert.deepEqual(Object.keys(rotation).sort(),['controllerDigest','fragmentDigest','imageId','operationId','originalSecretId','previousDigest','replacementDigest','runtimeDigest','sourceDigest'].sort());
  assert.equal(rotation.operationId,marker.operationId);
  assert.match(rotation.originalSecretId,/^[A-Za-z0-9_-]{1,128}$/u);
  for(const key of ['controllerDigest','fragmentDigest','previousDigest','replacementDigest','runtimeDigest','sourceDigest'])assert.match(rotation[key],/^[a-f0-9]{64}$/u);
  assert.match(rotation.imageId,/^[a-f0-9]{64}$/u);
  assert.notEqual(rotation.previousDigest,rotation.replacementDigest,'Tunnel token replacement must differ from its rollback credential');
  return {root,rotation};
}
export async function saveTunnelTokenSnapshot({config,state,snapshot,previousToken,timer,routeContent}){
  assertTunnelTokenRotationState(state);
  validateTunnelToken(previousToken);
  const root=rotationSnapshotRoot(config,snapshot.operationId);
  await ensureDirectoryTreeDurable(root);
  assert.equal((await lstat(root)).mode&0o777,0o700,'Tunnel token snapshot directory must be private');
  assert.equal(matchesRotationCredential(previousToken,snapshot.operationId,snapshot.previousDigest),true,'Previous Tunnel token differs from captured identity');
  const previousTokenFile=path.join(root,'tunnel-token');
  await atomicWrite(previousTokenFile,previousToken);
  await atomicWrite(path.join(root,'controller.json'),JSON.stringify(state)+'\n');
  const marker={format:tunnelTokenRotationFormat,phase:'applying',operationId:snapshot.operationId,timer,routeContent,
    configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),stateFile:config.stateFile,routeFile:config.routeFile,
    previousTokenFile,rotation:{operationId:snapshot.operationId,originalSecretId:snapshot.originalSecretId,
      previousDigest:snapshot.previousDigest,replacementDigest:snapshot.replacementDigest,sourceDigest:snapshot.sourceDigest,
      fragmentDigest:snapshot.fragmentDigest,imageId:snapshot.imageId,runtimeDigest:snapshot.runtimeDigest,
      controllerDigest:createHash('sha256').update(JSON.stringify(state)).digest('hex')}};
  validateTunnelTokenRotationMarker(marker,config);
  return marker;
}
export async function loadTunnelTokenSnapshot({config,state,marker}){
  const {root,rotation}=validateTunnelTokenRotationMarker(marker,config);
  assert.equal(marker.phase,'applying','Completed Tunnel token rotation no longer needs rollback credentials');
  assert.deepEqual(JSON.parse(await readBoundedPrivateFile(path.join(root,'controller.json'),1024*1024)),state,'Tunnel token controller snapshot changed');
  assert.equal(createHash('sha256').update(JSON.stringify(state)).digest('hex'),rotation.controllerDigest,'Tunnel token controller identity changed');
  assertTunnelTokenRotationState(state);
  assert.equal(marker.routeContent,`${state.journal.active.slot}\n`,'Tunnel token route differs from the committed writer');
  const previousToken=validateTunnelToken(await readBoundedPrivateFile(marker.previousTokenFile,8193));
  assert.equal(matchesRotationCredential(previousToken,rotation.operationId,rotation.previousDigest),true,'Previous Tunnel token snapshot digest drift');
  return {snapshot:{...rotation},previousToken,root};
}

const preflightPasswordRotationFormat='codexia-maintenance-postgres-preflight-password/v1';
function assertPreflightPasswordRotationState(state){
  assert.ok(['idle','committed'].includes(state.journal.phase)&&!state.initialActivationPending&&state.lastError===null,
    'Preflight password rotation requires a stable initialized controller');
  assert.equal(state.journal.active.image,state.installed.image,'Committed writer image differs from the installed release');
}
function validatePreflightPasswordRotationMarker(marker,config){
  assert.ok(plainObject(marker),'Preflight-password recovery marker must be an object');
  assert.deepEqual(Object.keys(marker).sort(),['configPath','format','operationId','phase','previousPasswordFile','routeContent','routeFile','rotation','stateFile','timer'].sort());
  assert.equal(marker.format,preflightPasswordRotationFormat);
  assert.ok(['applying','completed','rolled-back'].includes(marker.phase),'Preflight-password recovery phase is invalid');
  timerActivationCommand(marker.timer);
  assert.equal(marker.configPath,path.join(path.dirname(config.publicKeyFile),'config.json'));
  assert.equal(marker.stateFile,config.stateFile);
  assert.equal(marker.routeFile,config.routeFile);
  assert.ok(['blue\n','green\n'].includes(marker.routeContent),'Preflight-password route snapshot is invalid');
  assert.match(marker.operationId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  const root=rotationSnapshotRoot(config,marker.operationId);
  assert.equal(path.resolve(marker.previousPasswordFile),path.join(root,'postgres-preflight-password'));
  assert.ok(plainObject(marker.rotation),'Preflight-password recovery identity is invalid');
  const keys=['adminSecretId','appSecretId','controllerDigest','databaseId','fragmentDigest','operationId','originalSecretId',
    'previousDigest','replacementDigest','resourcesDigest','runtimeDigest','sourceDigest'];
  assert.deepEqual(Object.keys(marker.rotation).sort(),keys.sort());
  assert.equal(marker.rotation.operationId,marker.operationId);
  for(const key of ['adminSecretId','appSecretId','originalSecretId'])assert.match(marker.rotation[key],/^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(marker.rotation.databaseId,/^[1-9]\d{0,19}:[1-9]\d{0,9}$/u);
  for(const key of ['controllerDigest','fragmentDigest','previousDigest','replacementDigest','resourcesDigest','runtimeDigest','sourceDigest'])
    assert.match(marker.rotation[key],/^[a-f0-9]{64}$/u);
  assert.notEqual(marker.rotation.previousDigest,marker.rotation.replacementDigest,'Preflight password must differ from its rollback credential');
  return {root,rotation:marker.rotation};
}
export async function savePreflightPasswordRotationSnapshot({config,state,snapshot,previousPassword,timer,routeContent}){
  assertPreflightPasswordRotationState(state);
  validatePostgresPreflightPassword(previousPassword);
  assert.equal(matchesRotationCredential(previousPassword,snapshot.operationId,snapshot.previousDigest),true);
  assert.equal(routeContent,`${state.journal.active.slot}\n`,'Preflight-password route differs from the committed writer');
  assert.ok(typeof snapshot.databaseQuadlet==='string'&&snapshot.databaseQuadlet.length>0);
  const root=rotationSnapshotRoot(config,snapshot.operationId);
  await ensureDirectoryTreeDurable(root);
  assert.equal((await lstat(root)).mode&0o777,0o700,'Preflight-password snapshot directory must be private');
  const previousPasswordFile=path.join(root,'postgres-preflight-password');
  const {databaseQuadlet,...identity}=snapshot;
  identity.controllerDigest=createHash('sha256').update(JSON.stringify(state)).digest('hex');
  identity.resourcesDigest=createHash('sha256').update(JSON.stringify(snapshot.resources)).digest('hex');
  await atomicWrite(previousPasswordFile,previousPassword);
  await atomicWrite(path.join(root,'codexia-db.container'),databaseQuadlet);
  await atomicWrite(path.join(root,'identity.json'),JSON.stringify(identity)+'\n');
  await atomicWrite(path.join(root,'controller.json'),JSON.stringify(state)+'\n');
  const marker={format:preflightPasswordRotationFormat,phase:'applying',operationId:snapshot.operationId,timer,routeContent,
    configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),stateFile:config.stateFile,routeFile:config.routeFile,
    previousPasswordFile,rotation:{operationId:snapshot.operationId,adminSecretId:snapshot.adminSecretId,appSecretId:snapshot.appSecretId,
      originalSecretId:snapshot.originalSecretId,previousDigest:snapshot.previousDigest,replacementDigest:snapshot.replacementDigest,
      sourceDigest:snapshot.sourceDigest,fragmentDigest:snapshot.fragmentDigest,databaseId:snapshot.databaseId,
      resourcesDigest:identity.resourcesDigest,runtimeDigest:snapshot.runtimeDigest,controllerDigest:identity.controllerDigest}};
  validatePreflightPasswordRotationMarker(marker,config);
  return marker;
}
export async function loadPreflightPasswordRotationSnapshot({config,state,marker}){
  const {root,rotation}=validatePreflightPasswordRotationMarker(marker,config);
  assert.ok(['applying','completed','rolled-back'].includes(marker.phase));
  const controllerState=JSON.parse(await readBoundedPrivateFile(path.join(root,'controller.json'),1024*1024));
  const normalizedState={...state,paused:controllerState.paused};
  assert.deepEqual(normalizedState,controllerState,'Preflight-password controller changed outside fail-closed pause');
  assert.ok(state.paused===controllerState.paused||state.paused===true,
    'Preflight-password recovery cannot unpause a controller that was previously paused');
  assertPreflightPasswordRotationState(controllerState);
  assertPreflightPasswordRotationState(state);
  assert.equal(createHash('sha256').update(JSON.stringify(controllerState)).digest('hex'),rotation.controllerDigest,
    'Preflight-password controller identity changed');
  assert.equal(marker.routeContent,`${controllerState.journal.active.slot}\n`,'Preflight-password route differs from committed writer');
  const identity=JSON.parse(await readBoundedPrivateFile(path.join(root,'identity.json'),128*1024));
  assert.equal(identity.operationId,marker.operationId);
  assert.equal(identity.databaseId,rotation.databaseId);
  assert.equal(identity.controllerDigest,rotation.controllerDigest);
  assert.equal(identity.resourcesDigest,rotation.resourcesDigest);
  const databaseQuadlet=await readBoundedPrivateFile(path.join(root,'codexia-db.container'),65536);
  let previousPassword=null;
  if(marker.phase==='applying'){
    previousPassword=validatePostgresPreflightPassword(await readBoundedPrivateFile(marker.previousPasswordFile,65));
    assert.equal(matchesRotationCredential(previousPassword,rotation.operationId,rotation.previousDigest),true,
      'Previous preflight password snapshot digest drift');
  }
  return {snapshot:{...identity,databaseQuadlet},controllerState,previousPassword};
}

const apiTokenRotationFormat='codexia-maintenance-api-auth-token/v1';
export async function saveApiAuthTokenSnapshot({config,state,snapshot,previousToken,replacementToken,timer}){
  const root=rotationSnapshotRoot(config,snapshot.operationId);
  await ensureDirectoryTreeDurable(root);
  assert.equal((await lstat(root)).mode&0o777,0o700,'API token snapshot directory must be private');
  validateStandaloneAuthToken(previousToken);validateStandaloneAuthToken(replacementToken);
  assert.equal(matchesRotationCredential(previousToken,snapshot.operationId,snapshot.previousDigest),true,'Previous API token differs from its captured identity');
  assert.equal(matchesRotationCredential(replacementToken,snapshot.operationId,snapshot.replacementDigest),true,'Replacement API token differs from its admitted candidate');
  const previousTokenFile=path.join(root,'api-auth-token');
  const replacementTokenFile=path.join(root,'api-auth-token-replacement');
  await atomicWrite(previousTokenFile,previousToken);
  await atomicWrite(replacementTokenFile,replacementToken);
  await atomicWrite(path.join(root,'controller.json'),JSON.stringify(state)+'\n');
  const rotation={format:'codexia-api-auth-token-rotation/v1',secretName:'codexia-auth-token',operationId:snapshot.operationId,
    originalSecretId:snapshot.originalSecretId,previousDigest:snapshot.previousDigest,replacementDigest:snapshot.replacementDigest,
    previousTokenFile,replacementTokenFile,slot:state.journal.active.slot,releaseImage:state.installed.image};
  return {format:apiTokenRotationFormat,phase:'applying',operationId:snapshot.operationId,timer,rotation,
    configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),stateFile:config.stateFile,routeFile:config.routeFile};
}
async function validateApiAuthTokenSnapshotIdentity({config,state,marker}){
  assert.deepEqual(Object.keys(marker).sort(),['configPath','format','operationId','phase','routeFile','rotation','stateFile','timer'].sort());
  assert.equal(marker.format,apiTokenRotationFormat);
  assert.ok(['applying','completed','rolled-back'].includes(marker.phase),'API token recovery phase is invalid');
  timerActivationCommand(marker.timer);
  assert.equal(marker.configPath,path.join(path.dirname(config.publicKeyFile),'config.json'));
  assert.equal(marker.stateFile,config.stateFile);
  assert.equal(marker.routeFile,config.routeFile);
  const root=rotationSnapshotRoot(config,marker.operationId);
  const rotation=marker.rotation;
  assert.ok(plainObject(rotation),'API token recovery identity is invalid');
  assert.deepEqual(Object.keys(rotation).sort(),['format','operationId','originalSecretId','previousDigest','previousTokenFile','releaseImage','replacementDigest','replacementTokenFile','secretName','slot'].sort());
  assert.equal(rotation.format,'codexia-api-auth-token-rotation/v1');
  assert.equal(rotation.operationId,marker.operationId);
  assert.equal(rotation.secretName,'codexia-auth-token');
  assert.equal(path.resolve(rotation.previousTokenFile),path.join(root,'api-auth-token'));
  assert.equal(path.resolve(rotation.replacementTokenFile),path.join(root,'api-auth-token-replacement'));
  assert.match(rotation.originalSecretId,/^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(rotation.previousDigest,/^[a-f0-9]{64}$/u);assert.match(rotation.replacementDigest,/^[a-f0-9]{64}$/u);
  assert.ok(['blue','green'].includes(rotation.slot));
  assert.match(rotation.releaseImage,/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u);
  const controller=JSON.parse(await readBoundedPrivateFile(path.join(root,'controller.json'),1024*1024));
  assert.deepEqual(controller,state,'API token controller snapshot changed');
  assertApiTokenRotationState(state);
  assert.equal(rotation.slot,state.journal.active.slot);assert.equal(rotation.releaseImage,state.installed.image);
  return {root,rotation};
}
export async function loadApiAuthTokenSnapshot({config,state,marker}){
  const {root,rotation}=await validateApiAuthTokenSnapshotIdentity({config,state,marker});
  assert.equal(marker.phase,'applying','A committed API token rotation no longer needs rollback credentials');
  const previousToken=validateStandaloneAuthToken(await readBoundedPrivateFile(rotation.previousTokenFile,8192));
  const replacementToken=validateStandaloneAuthToken(await readBoundedPrivateFile(rotation.replacementTokenFile,8192));
  assert.equal(matchesRotationCredential(previousToken,rotation.operationId,rotation.previousDigest),true,'Previous API token snapshot digest drift');
  assert.equal(matchesRotationCredential(replacementToken,rotation.operationId,rotation.replacementDigest),true,'Replacement API token snapshot digest drift');
  assert.ok(previousToken.replace(/\n$/u,'')!==replacementToken.replace(/\n$/u,''),'API token recovery snapshot contains identical credentials');
  return {snapshot:{...rotation},previousToken,replacementToken};
}
function assertApiTokenRotationState(state){
  assert.equal(state.paused,true,'API token rotation requires a paused controller');
  assert.ok(['committed','idle'].includes(state.journal.phase)&&!state.initialActivationPending&&state.lastError===null,
    'API token rotation requires a stable initialized controller');
  assert.equal(state.journal.active.image,state.installed.image,'Committed writer image differs from release');
}
export async function recoverApiAuthTokenWriter({host,controller,state,snapshot,previousToken,replacementToken}){
  assertApiTokenRotationState(state);
  const slot=state.journal.active.slot;
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(slot);
  host.assertApiAuthTokenSecret(snapshot);
  const observed=await host.observe();
  assert.equal(observed.route,'blocked','API token recovery requires blocked admission');
  if(observed.writers.length){
    assert.deepEqual(observed.writers,[{slot,image:state.installed.image}],'Unexpected writer prevents API token recovery');
    await host.assertNoWriterContainers(slot);
    await host.stopWriter(slot);
  }else await host.assertNoWriterContainers();
  await host.assertNoWriterContainers();
  host.assertApiAuthTokenSecret(snapshot);
  await host.replaceApiAuthToken(previousToken,snapshot);
  await host.startWriter(slot,state.installed);
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(slot);
  await host.verifyApiAuthToken(slot,previousToken,200);
  await host.verifyApiAuthToken(slot,replacementToken,401);
  await host.route(slot);
  await controller.assertServing(state,slot,state.installed);
}
export function validatePostgresAppPasswordRotation(value,snapshotRoot){
  assert.ok(plainObject(value),'App-password recovery marker must be an object');
  assert.deepEqual(Object.keys(value).sort(),['databaseId','format','previousPasswordFile','releaseImage','secretName','slot'],
    'Unexpected app-password recovery marker fields');
  assert.equal(value.format,'codexia-postgres-app-password-rotation/v1');
  assert.equal(value.secretName,'codexia-postgres-app-password','App-password recovery may replace only its canonical Podman secret');
  assert.ok(path.isAbsolute(snapshotRoot),'App-password recovery snapshot path must be absolute');
  assert.equal(path.resolve(value.previousPasswordFile),path.join(path.resolve(snapshotRoot),'postgres-app-password'),
    'App-password recovery secret escaped its private snapshot');
  assert.match(value.databaseId,/^[1-9]\d{0,19}:[1-9]\d{0,9}$/u,'Invalid app-password recovery database identity');
  assert.ok(['blue','green'].includes(value.slot),'Invalid app-password recovery writer slot');
  assert.match(value.releaseImage,/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u,'Invalid app-password recovery release image');
  return value;
}

export function validateMaintenanceConfig(current,candidate){
  assert.ok(plainObject(current)&&plainObject(candidate),'Maintenance configuration must be an object');
  assert.equal(typeof current.enabled,'boolean','Current update enabled state is unobservable');
  assert.equal(typeof candidate.enabled,'boolean','Candidate update enabled state is invalid');
  assert.ok(Number.isSafeInteger(current.observeMilliseconds),'Current updater observation interval is invalid');
  assert.ok(Number.isSafeInteger(candidate.observeMilliseconds)&&candidate.observeMilliseconds>=60000&&candidate.observeMilliseconds<=3600000,'Candidate observation interval must be 60 seconds–60 minutes');
  if(current.runtime!==undefined)assert.ok(candidate.runtime!==undefined,'Maintenance cannot remove the typed runtime contract');
  if(candidate.runtime!==undefined){
    validateRuntimeContract(candidate.runtime);
    if(current.runtime!==undefined)assert.equal(candidate.runtime.profile,current.runtime.profile,'Runtime profile changes require a compatible signed release transition');
  }
  // A first Phase C maintenance run may adopt the typed contract only after
  // the running writer has been observed against it below.
  const normalizedCurrent={...current,observeMilliseconds:candidate.observeMilliseconds,runtime:candidate.runtime??current.runtime};
  const normalizedCandidate={...candidate,enabled:current.enabled};
  assert.deepEqual(normalizedCandidate,normalizedCurrent,'Maintenance cannot change release trust, browser authentication, runtime, host paths, or other controller identity');
  return normalizedCandidate;
}
export function assertProxyImageStable(currentText,candidateText){
  const images=text=>[...text.matchAll(/^Image=(\S+)$/gmu)].map(match=>match[1]);
  const current=images(currentText),candidate=images(candidateText);
  assert.equal(current.length,1,'Current proxy image identity is unobservable');
  assert.equal(candidate.length,1,'Candidate proxy image identity is unobservable');
  assert.match(current[0],/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u,'Current proxy image is not digest pinned');
  assert.equal(candidate[0],current[0],'A proxy image change requires its own reviewed transition');
}

export function assertNoDropInPaths(value){
  assert.equal(typeof value,'string','Systemd unit override paths are unobservable');
  assert.equal(value.trim(),'','Systemd unit drop-ins are not part of the reviewed updater contract');
}

export async function activateProxyRevision({changed,restart,verify}){
  assert.equal(typeof changed,'boolean','Proxy revision change state is unobservable');
  assert.equal(typeof restart,'function','Proxy restart operation is unavailable');
  assert.equal(typeof verify,'function','Proxy verification operation is unavailable');
  if(!changed)return false;
  await restart();
  await verify();
  return true;
}

export async function transitionRuntimeWriter({currentHost,targetHost,slot,release,state,verify}){
  assert.ok(['blue','green'].includes(slot),'Runtime maintenance writer slot is invalid');
  assert.equal(state?.journal?.active?.slot,slot,'Runtime maintenance must preserve the committed writer slot');
  assert.equal(typeof verify,'function','Runtime maintenance verification is unavailable');
  await targetHost.route('blocked');
  await currentHost.stopWriter(slot);
  await targetHost.convergeWriterUnits(state);
  await targetHost.startWriter(slot,release);
  await targetHost.route(slot);
  try{await verify();}catch(error){await targetHost.route('blocked').catch(()=>undefined);throw error;}
}

export async function transitionAuthTokenWriter({host,state,oldToken,newToken,snapshot,verify}){
  const slot=state?.journal?.active?.slot;
  assert.ok(['blue','green'].includes(slot),'API token rotation requires the committed writer slot');
  assert.equal(state.journal.active.image,state.installed?.image,'Committed writer image differs from release');
  validateStandaloneAuthToken(oldToken);
  validateStandaloneAuthToken(newToken);
  assert.ok(oldToken.replace(/\n$/u,'')!==newToken.replace(/\n$/u,''),'Replacement API token must differ from the current token');
  assert.equal(typeof verify,'function','API token rotation verification is unavailable');
  await host.route('blocked');
  await host.stopWriter(slot);
  await host.replaceApiAuthToken(newToken,snapshot);
  await host.startWriter(slot,state.installed);
  await host.verifyWriterUnits(state);
  await host.verifyApiAuthToken(slot,newToken,200);
  await host.verifyApiAuthToken(slot,oldToken,401);
  await host.route(slot);
  await verify();
}

/** Restore only the journal-owned writer after a credential-only interruption.
 * A committed image needs no new release admission; never overwrite an unknown
 * stopped container or discard an unrelated disposable preflight. */
export async function recoverProbeCredentialWriter({host,state}){
  assert.ok(['idle','committed'].includes(state.journal.phase)&&!state.initialActivationPending&&state.lastError===null,'Credential recovery requires a stable committed writer');
  assert.ok(host.runtime,'Credential recovery requires the reviewed typed runtime');
  const {slot,image}=state.journal.active;
  assert.equal(image,state.installed.image,'Committed writer image differs from release');
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(slot);
  const observed=await host.observe();
  assert.equal(observed.route,'blocked','Credential recovery requires blocked admission');
  if(observed.writers.length===0){
    await host.assertNoWriterContainers();
    await host.startWriter(slot,state.installed);
    await host.verifyWriterUnits(state);
  }else{
    assert.deepEqual(observed.writers,[{slot,image}],'Unexpected writer prevents credential recovery');
    await host.assertNoWriterContainers(slot);
  }
  const after=await host.observe();
  assert.equal(after.route,'blocked','Writer recovery changed the private route');
  assert.deepEqual(after.writers,[{slot,image}],'Committed writer recovery is unverified');
  await host.assertNoWriterContainers(slot);
}

export async function preflightMaintenanceRuntime({currentConfig,nextConfig,currentHost,candidateHost,currentController,candidateController,state,activeSlot}){
  const adoptingRuntime=currentConfig.runtime===undefined&&nextConfig.runtime!==undefined;
  const observedHost=adoptingRuntime?candidateHost:currentHost;
  const observedController=adoptingRuntime?candidateController:currentController;
  await observedHost.verifyWriterUnits(state);
  await observedController.assertServing(state,activeSlot,state.installed);
  return adoptingRuntime;
}

function assertRotationState(state){
  assert.equal(state.paused,true,'App-password rotation requires a paused controller');
  assert.ok(['committed','idle'].includes(state.journal.phase)&&!state.initialActivationPending&&state.lastError===null,
    'App-password rotation requires a stable initialized journal');
  assert.equal(state.journal.active.image,state.installed.image,'Committed writer image differs from the installed release');
}

export async function applyPostgresAppPassword({host,state,snapshot,password,recovering,verify}){
  assertRotationState(state);
  validatePostgresAppPassword(password);
  const {slot,image}=state.journal.active;
  let phase='route fence';
  try{
    await host.route('blocked');
    phase='source admission';
    await host.assertPasswordRotationSources(snapshot);
    await host.assertRuntimeSources();
    await host.assertInitialLegacyAbsent();
    await host.assertNoPreflight();
    await host.verifyWriterUnits(state);
    await host.assertCommittedWriterUnitSource(slot);
    phase='database identity admission';
    const running=await host.passwordRotationDatabase(snapshot);
    if(running)assert.equal(await host.passwordRotationDatabaseId(),snapshot.databaseId,'Database identity changed');
    else assert.ok(recovering,'Database disappeared before rotation');
    const observed=await host.observe();
    assert.equal(observed.route,'blocked');
    phase='writer fence';
    if(observed.writers.length){
      assert.deepEqual(observed.writers,[{slot,image}],'Unexpected writer prevents app-password rotation');
      await host.assertNoWriterContainers(slot);
      await host.stopWriter(slot);
    }else assert.ok(recovering,'Committed writer disappeared before rotation');
    await host.assertNoWriterContainers();
    // The forward operation uses the currently admitted DB. Recovery can begin
    // with a missing secret and no DB, so restore the mount first in that case.
    if(!recovering){phase='SQL role update';await host.changePostgresAppPassword(password);}
    phase='database stop';
    await host.stopPasswordRotationDatabase(snapshot);
    phase='immutable secret replacement';
    await host.replacePostgresAppSecret(password,snapshot);
    phase='database restart and identity verification';
    await host.startPasswordRotationDatabase(snapshot);
    assert.equal(await host.passwordRotationDatabaseId(),snapshot.databaseId,'Restarted database identity changed');
    if(recovering){phase='SQL role restore';await host.changePostgresAppPassword(password);}
    phase='credential verification';
    await host.verifyPostgresAppPassword(password);
    await host.verifyWriterUnits(state);
    await host.assertCommittedWriterUnitSource(slot);
    phase='writer restart and route verification';
    await host.startWriter(slot,state.installed);
    await host.verifyBlockedPasswordRotation(slot,state.installed);
    phase='route restore and final verification';
    await host.route(slot);
    await verify();
  }catch(error){
    await host.route('blocked').catch(()=>{});
    const detail=error instanceof Error?error.message:'unknown failure';
    throw Error(`PostgreSQL app-password rotation failed during ${phase}: ${detail}`,{cause:error});
  }
}

const rotationFormat='codexia-maintenance-postgres-app-password/v1';
function rotationSnapshotRoot(config,id){
  assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,'Invalid rotation snapshot identity');
  // The private proxy mounts the state directory read-only. Keep rollback
  // credentials in the service account's controller configuration directory.
  return path.join(path.dirname(config.publicKeyFile),'maintenance-snapshots',id);
}
async function readBoundedPrivateFile(filename,limit){
  const info=await lstat(filename);
  assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=limit,'Invalid protected maintenance input');
  return readRegularFile(filename);
}
export async function checkRotationBackup({stateDir,receiptFile,state,host,databaseId,requirePaused=true}){
  if(requirePaused)assertRotationState(state);
  else assertPreflightPasswordRotationState(state);
  const proof=validateControllerBackupProof(JSON.parse(await readBoundedPrivateFile(path.join(stateDir,'controller-backup-proof.json'),65536)));
  const receipt=JSON.parse(await readBoundedPrivateFile(receiptFile,65536));
  return assertMatchingControllerBackup(proof,receipt,state,databaseId,await host.backupArtifactIdentity(proof.artifactDirectory));
}

export async function savePasswordRotationSnapshot({config,state,snapshot,previousPassword,timer}){
  const root=rotationSnapshotRoot(config,snapshot.operationId);
  await ensureDirectoryTreeDurable(root);
  assert.equal((await lstat(root)).mode&0o777,0o700,'Rotation snapshot directory must be private');
  const previousPasswordFile=path.join(root,'postgres-app-password');
  const rotation=validatePostgresAppPasswordRotation({format:'codexia-postgres-app-password-rotation/v1',secretName:'codexia-postgres-app-password',
    previousPasswordFile,databaseId:snapshot.databaseId,slot:state.journal.active.slot,releaseImage:state.installed.image},root);
  const {databaseQuadlet,...identity}=snapshot;
  await atomicWrite(previousPasswordFile,validatePostgresAppPassword(previousPassword));
  await atomicWrite(path.join(root,'codexia-db.container'),databaseQuadlet);
  await atomicWrite(path.join(root,'identity.json'),JSON.stringify(identity)+'\n');
  await atomicWrite(path.join(root,'controller.json'),JSON.stringify(state)+'\n');
  return {format:rotationFormat,operationId:snapshot.operationId,timer,rotation};
}
export async function loadPasswordRotationSnapshot({config,state,marker}){
  assert.deepEqual(Object.keys(marker).sort(),['format','operationId','rotation','timer']);
  assert.equal(marker.format,rotationFormat);
  timerActivationCommand(marker.timer);
  const root=rotationSnapshotRoot(config,marker.operationId);
  const rotation=validatePostgresAppPasswordRotation(marker.rotation,root);
  assert.deepEqual(JSON.parse(await readBoundedPrivateFile(path.join(root,'controller.json'),1024*1024)),state,'Rotation controller snapshot changed');
  assertRotationState(state);
  assert.equal(rotation.slot,state.journal.active.slot);
  assert.equal(rotation.releaseImage,state.installed.image);
  const identity=JSON.parse(await readBoundedPrivateFile(path.join(root,'identity.json'),128*1024));
  assert.equal(identity.operationId,marker.operationId);
  assert.equal(identity.databaseId,rotation.databaseId);
  const databaseQuadlet=await readBoundedPrivateFile(path.join(root,'codexia-db.container'),65536);
  const password=validatePostgresAppPassword(await readBoundedPrivateFile(rotation.previousPasswordFile,65));
  assert.ok(matchesRotationCredential(password,identity.operationId,identity.previousDigest),'Previous password snapshot is unverified');
  return {snapshot:{...identity,databaseQuadlet},password};
}

async function restartProxyService(){
  assertNoDropInPaths(run('systemctl',['--user','show','--property=DropInPaths','--value','codexia-api-proxy.service']));
  run('systemctl',['--user','restart','codexia-api-proxy.service'],{timeout:120000});
  assert.equal(run('systemctl',['--user','show','--property=ActiveState','--value','codexia-api-proxy.service']),'active','Private proxy did not become active after maintenance restart');
}

export function timerActivationCommand(expected){
  assert.ok(expected&&['active','inactive'].includes(expected.active),'Updater timer active state is invalid');
  assert.ok(['enabled','disabled'].includes(expected.enabled),'Updater timer enabled state is invalid');
  return expected.active==='active'?'start':'stop';
}

function run(binary,args){
  try{return execFileSync(binary,args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).trim();}
  catch(error){throw new Error(binary+' '+args[0]+' failed (status '+String(error.status??'unknown')+')');}
}
function commandState(args,accepted){
  const result=spawnSync('systemctl',args,{encoding:'utf8',timeout:15000});
  const value=result.stdout.trim();
  assert.ok(accepted.includes(value),'Systemd state is not safely observable: '+args.join(' '));
  if(result.status!==0)assert.ok(args[1]==='is-active'&&['inactive','failed'].includes(value)||args[1]==='is-enabled'&&['disabled'].includes(value),'Systemd state query failed: '+args.join(' '));
  return value;
}
function timerState(){
  return {
    active:commandState(['--user','is-active','codexia-updater.timer'],['active','inactive']),
    enabled:commandState(['--user','is-enabled','codexia-updater.timer'],['enabled','disabled']),
  };
}
function assertTimerState(expected){
  assert.deepEqual(timerState(),expected,'Maintenance changed updater timer activation');
}
function updaterServiceState(){
  return commandState(['--user','is-active','codexia-updater.service'],['active','inactive','failed']);
}
function assertNoActiveUpdaterService(){
  const observed=updaterServiceState();
  if(observed==='failed')run('systemctl',['--user','reset-failed','codexia-updater.service']);
  assert.equal(updaterServiceState(),'inactive','Updater poll service is not idle under the maintenance lock');
}
async function stopTimerPolling(){
  run('systemctl',['--user','stop','codexia-updater.timer']);
  assertNoActiveUpdaterService();
  assert.equal(timerState().active,'inactive','Updater timer did not suspend polling');
}
async function restoreTimerPolling(expected){
  run('systemctl',['--user',timerActivationCommand(expected),'codexia-updater.timer']);
  assertNoActiveUpdaterService();
  assertTimerState(expected);
}
async function keepTimerStopped(){
  run('systemctl',['--user','stop','codexia-updater.timer']);
  const observed=updaterServiceState();
  if(observed==='failed')run('systemctl',['--user','reset-failed','codexia-updater.service']);
}
function withPause(state,paused){return {...state,paused};}
function withoutPause(state){
  const copy={...state};delete copy.paused;return copy;
}
async function readRegularFile(filename,{required=true}={}){
  let observed;
  try{observed=await lstat(filename);}catch(error){
    if(error.code==='ENOENT'&&!required)return null;
    throw error;
  }
  assert.ok(observed.isFile()&&!observed.isSymbolicLink(),'Maintenance target must be a regular non-symlink file');
  assert.equal(observed.mode&0o777,0o600,'Maintenance target permissions drift');
  if(typeof process.getuid==='function')assert.equal(observed.uid,process.getuid(),'Maintenance target owner drift');
  const parent=path.dirname(filename);
  assert.equal(await realpath(parent),path.resolve(parent),'Maintenance target parent cannot traverse a symlink');
  return await readFile(filename,'utf8');
}
async function readCandidate(root,relative){
  assert.ok(!path.isAbsolute(relative)&&!relative.split(path.sep).includes('..'),'Candidate path escapes its staging root');
  const filename=path.join(root,relative);
  assert.ok(filename.startsWith(root+path.sep),'Candidate path escapes its staging root');
  const observed=await lstat(filename);
  assert.ok(observed.isFile()&&!observed.isSymbolicLink(),'Candidate file must be a regular non-symlink file');
  assert.equal(observed.mode&0o777,0o600,'Candidate file permissions drift');
  assert.equal(await realpath(filename),filename,'Candidate file cannot traverse a symlink');
  return await readFile(filename,'utf8');
}
async function assertUnitLoaded(unitName,expectedPath){
  const observed=run('systemctl',['--user','show','--property=FragmentPath','--value',unitName]);
  assert.equal(path.resolve(observed),path.resolve(expectedPath),'Systemd did not load the reviewed unit file');
  assertNoDropInPaths(run('systemctl',['--user','show','--property=DropInPaths','--value',unitName]));
}
async function snapshotFiles(files,snapshotRoot){
  const records=[];
  for(let index=0;index<files.length;index++){
    const entry=files[index];
    const content=await readRegularFile(entry.target,{required:!entry.allowMissing});
    const backup=path.join(snapshotRoot,'previous',String(index).padStart(3,'0'));
    if(content!==null){
      await ensureDirectoryTreeDurable(path.dirname(backup));
      await atomicWrite(backup,content);
    }
    records.push({target:entry.target,backup,exists:content!==null});
  }
  return records;
}
async function restoreFiles(records){
  for(const record of records){
    if(record.exists){
      const content=await readFile(record.backup,'utf8');
      await atomicWrite(record.target,content);
      await chmod(record.target,0o600);
    }else await rm(record.target,{force:true});
  }
}
async function writeCandidates(files){
  for(const entry of files)await atomicWrite(entry.target,entry.content);
}
function assertStateExceptPause(expected,observed){
  assert.deepEqual(withoutPause(observed),withoutPause(expected),'Maintenance changed controller journal/checkpoint state');
}
async function readTransaction(markerPath){
  let raw;
  try{raw=await readFile(markerPath,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const marker=JSON.parse(raw);
  if(marker.format===rotationFormat||marker.format===preflightPasswordRotationFormat||marker.format===apiTokenRotationFormat||marker.format===tunnelTokenRotationFormat)return marker;
  assert.equal(marker.format,'codexia-maintenance-transaction/v1');
  assert.ok(path.isAbsolute(marker.snapshotRoot)&&path.isAbsolute(marker.configPath)&&path.isAbsolute(marker.sourceDir)&&path.isAbsolute(marker.unitDir));
  assert.ok(Array.isArray(marker.files)&&marker.files.every(item=>typeof item.target==='string'&&typeof item.backup==='string'&&typeof item.exists==='boolean'));
  assert.equal(typeof marker.originalPaused,'boolean');
  assert.equal(typeof marker.stateFile,'string');
  assert.equal(typeof marker.routeFile,'string');
  assert.equal(typeof marker.routeContent,'string');
  assert.equal(typeof marker.quadletDir,'string');
  assert.equal(marker.updaterServiceState,'inactive');
  if(marker.proxyRestartRequired===undefined)marker.proxyRestartRequired=false;
  assert.equal(typeof marker.proxyRestartRequired,'boolean');
  if(marker.runtimeChanged===undefined)marker.runtimeChanged=false;
  assert.equal(typeof marker.runtimeChanged,'boolean');
  assert.ok(marker.timerState&&['active','inactive'].includes(marker.timerState.active)&&['enabled','disabled'].includes(marker.timerState.enabled));
  if(marker.probeCredentialsRotated!==undefined)assert.equal(marker.probeCredentialsRotated,true,'Invalid probe credential recovery marker');
  const credentialTargets=Object.values(probeCredentialNames).map(name=>path.join(path.dirname(marker.configPath),name));
  if(marker.probeCredentialsRotated){
    assert.ok(!marker.runtimeChanged&&!marker.proxyRestartRequired,'Credential-only recovery cannot change writer or proxy configuration');
    assert.deepEqual(marker.files.map(item=>item.target).sort(),[...credentialTargets].sort(),'Credential recovery requires exactly the canonical credential targets');
    assert.ok(marker.files.every(item=>item.exists),'Credential rotation requires existing protected inputs');
  }
  const allowedTargets=new Set([
    ...(marker.probeCredentialsRotated?credentialTargets:[]),
    ...MAINTENANCE_SOURCE_FILES.map(relative=>path.join(marker.sourceDir,relative)),
    ...MAINTENANCE_UNIT_FILES.map(filename=>path.join(marker.unitDir,filename)),
    marker.configPath,
    path.join(marker.quadletDir,'codexia-api-proxy.container'),
  ]);
  assert.ok(marker.files.every(item=>allowedTargets.has(item.target)),'Interrupted maintenance target escaped the reviewed file set');
  assert.ok(marker.files.every(item=>item.backup.startsWith(path.join(marker.snapshotRoot,'previous')+path.sep)),'Interrupted maintenance backup escaped its snapshot');
  assert.ok(marker.snapshotRoot.startsWith(path.join(path.dirname(marker.stateFile),'maintenance','snapshots')+path.sep),'Interrupted maintenance snapshot escaped its private state directory');
  return marker;
}
export async function assertMaintenanceSnapshotVerifier({config,configPath,entry}){
  const markerPath=path.join(path.dirname(config.stateFile),'maintenance','in-progress.json');
  const info=await lstat(markerPath);
  assert.ok(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600&&info.uid===process.getuid(),'Invalid maintenance verification marker');
  const marker=await readTransaction(markerPath);
  assert.ok(marker&&marker.stateFile===config.stateFile&&marker.routeFile===config.routeFile&&marker.configPath===configPath,'Maintenance verification identity mismatch');
  const expected=path.join(marker.snapshotRoot,'old-source','deploy/updater/standalone-updater.mjs');
  assert.equal(entry,expected,'Pending runtime maintenance requires recovery before other operations');
  assert.equal(await realpath(expected),expected,'Maintenance snapshot verifier must use its real path');
}
async function verifyOldCode(marker){
  const oldEntry=path.join(marker.snapshotRoot,'old-source','deploy/updater/standalone-updater.mjs');
  await readFile(oldEntry,'utf8');
  execFileSync('node',[oldEntry,'verify',marker.configPath],{
    encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024,
    env:{...process.env,CODEXIA_UPDATER_LOCK_DIRECTORY:path.dirname(marker.stateFile)},
    stdio:['ignore','pipe','pipe'],
  });
}
async function recoverInterrupted(config,store,markerPath,publicKey){
  const blockRoute=()=>atomicWrite(config.routeFile,'blocked\n');
  let markerInfo;
  try{markerInfo=await lstat(markerPath);}catch(error){
    if(error.code==='ENOENT')return false;
    await blockRoute().catch(()=>undefined);
    await keepTimerStopped().catch(()=>undefined);
    throw error;
  }
  try{await blockRoute();}
  catch(error){await keepTimerStopped().catch(()=>undefined);throw error;}
  try{
    await stopTimerPolling();
    assert.ok(markerInfo.isFile()&&!markerInfo.isSymbolicLink(),'Interrupted maintenance marker must be a regular non-symlink file');
    assert.equal(markerInfo.mode&0o777,0o600,'Interrupted maintenance marker permissions drift');
    if(typeof process.getuid==='function')assert.equal(markerInfo.uid,process.getuid(),'Interrupted maintenance marker owner drift');
    const marker=await readTransaction(markerPath);
    assert.ok(marker,'Interrupted maintenance marker disappeared during recovery');
    if(marker.format===rotationFormat){
      try{await recoverPasswordRotation({config,store,publicKey,marker,markerPath});}
      catch(error){throw Error('Interrupted password rotation recovery is unverified',{cause:error});}
      return true;
    }
    if(marker.format===preflightPasswordRotationFormat){
      try{await recoverPreflightPasswordRotation({config,store,publicKey,marker,markerPath});}
      catch(error){throw Error('Interrupted preflight-password recovery is unverified',{cause:error});}
      return true;
    }
    if(marker.format===apiTokenRotationFormat){
      try{await recoverApiAuthTokenRotation({config,store,publicKey,marker,markerPath});}
      catch(error){throw Error('Interrupted API token rotation recovery is unverified',{cause:error});}
      return true;
    }
    if(marker.format===tunnelTokenRotationFormat){
      try{await recoverTunnelTokenRotation({config,store,publicKey,marker,markerPath});}
      catch(error){throw Error('Interrupted Tunnel token rotation recovery is unverified',{cause:error});}
      return true;
    }
    assert.equal(marker.stateFile,config.stateFile,'Interrupted maintenance belongs to a different controller');
    assert.equal(marker.routeFile,config.routeFile,'Interrupted maintenance belongs to a different route');
    const stateBefore=await loadControllerState(marker.stateFile);
    assertStateExceptPause(JSON.parse(await readFile(path.join(marker.snapshotRoot,'controller.json'),'utf8')),stateBefore);
    await restoreFiles(marker.files);
    run('systemctl',['--user','daemon-reload']);
    const interruptedRoute=await readFile(marker.routeFile,'utf8');
    assert.ok(interruptedRoute===marker.routeContent||interruptedRoute==='blocked\n','Maintenance route changed during interrupted recovery');
    const oldConfig=JSON.parse(await readFile(marker.configPath,'utf8'));
    const oldHost=new PodmanStandaloneHost(oldConfig);
    if(marker.proxyRestartRequired){
      await oldHost.route('blocked');
      await activateProxyRevision({changed:true,restart:restartProxyService,verify:async()=>{}});
    }
    if(marker.runtimeChanged){
      const oldController=new StandaloneController({host:oldHost,store,publicKey,observeMilliseconds:oldConfig.observeMilliseconds??300000});
      await transitionRuntimeWriter({
        currentHost:oldHost,targetHost:oldHost,slot:stateBefore.journal.active.slot,release:stateBefore.installed,state:stateBefore,
        verify:async()=>{await oldHost.verifyWriterUnits(stateBefore);await oldController.assertServing(stateBefore,stateBefore.journal.active.slot,stateBefore.installed);},
      });
    }else{
      if(marker.probeCredentialsRotated)await recoverProbeCredentialWriter({host:oldHost,state:stateBefore});
      await oldHost.route(marker.routeContent.trim());
    }
    await verifyOldCode(marker);
    if(marker.probeCredentialsRotated)await assertProbeCredentialAccess(oldHost,stateBefore,publicKey);
    const after=await loadControllerState(marker.stateFile);
    assertStateExceptPause(JSON.parse(await readFile(path.join(marker.snapshotRoot,'controller.json'),'utf8')),after);
    if(after.paused!==marker.originalPaused)await store.save(withPause(after,marker.originalPaused));
    await restoreTimerPolling(marker.timerState);
    await clearBackupIntent(markerPath);
    await rm(marker.snapshotRoot,{recursive:true,force:true}).catch(()=>{});
    return true;
  }catch(error){
    await blockRoute().catch(()=>undefined);
    await keepTimerStopped().catch(()=>undefined);
    // A failure after restoring the prior pause flag must not leave an
    // apparently enabled controller while the durable marker is retained.
    try{
      const state=await loadControllerState(config.stateFile);
      if(!state.paused)await store.save(withPause(state,true));
    }catch{}
    throw error;
  }
}

export async function recoverInterruptedMaintenance({config,store,publicKey}){
  assert.equal(path.dirname(config.stateFile),process.env.CODEXIA_UPDATER_LOCK_DIRECTORY,'Boot recovery must use the canonical host lock');
  const markerPath=path.join(path.dirname(config.stateFile),'maintenance','in-progress.json');
  return recoverInterrupted(config,store,markerPath,publicKey);
}

function filesFor(manifest,config,candidateConfig){
  const sourceDir=path.resolve(manifest.sourceDir);
  const unitDir=path.resolve(manifest.unitDir);
  const quadletDir=path.resolve(config.quadletDirectory);
  const root=path.resolve(manifest.candidateRoot);
  return [
    ...MAINTENANCE_SOURCE_FILES.map(relative=>({
      target:path.join(sourceDir,relative),candidate:relative,allowMissing:relative==='deploy/updater/standalone-maintenance.mjs',
    })),
    ...MAINTENANCE_UNIT_FILES.map(filename=>({
      target:path.join(unitDir,filename),candidate:path.join('units',filename),
    })),
    {target:manifest.configPath,candidate:'config.json'},
    {target:path.join(quadletDir,'codexia-api-proxy.container'),candidate:path.join('quadlet','codexia-api-proxy.container')},
  ].map(entry=>({...entry,content:undefined,root}));
}
async function candidateFiles(entries,root){
  const result=[];
  let total=0;
  for(const entry of entries){
    const content=await readCandidate(root,entry.candidate);
    total+=Buffer.byteLength(content);
    assert.ok(total<=16*1024*1024,'Maintenance candidate exceeds the reviewed source limit');
    result.push({...entry,content});
  }
  return result;
}
async function checkFilesApplied(files){
  for(const entry of files)assert.ok((await readRegularFile(entry.target))===entry.content,'Maintenance file installation differs from its candidate');
}

async function assertRotationControlUnits(config){
  const unitDir=path.resolve(config.quadletDirectory,'../../../.config/systemd/user');
  for(const unit of MAINTENANCE_UNIT_FILES)await assertUnitLoaded(unit,path.join(unitDir,unit));
  const boot='codexia-updater-boot.service';
  const dependencies=property=>run('systemctl',['--user','show','--property='+property,'--value',boot]).split(/\s+/u);
  assert.ok(dependencies('Wants').includes('codexia-db.service')&&!dependencies('Requires').includes('codexia-db.service')&&
    dependencies('Requires').includes('codexia-api-proxy.service')&&dependencies('After').includes('codexia-db.service'),
    'Install the independently recoverable database boot unit before rotation');
}

async function finishRotation({config,state,host,controller,marker,markerPath,snapshot,password,recovering}){
  await assertRotationControlUnits(config);
  await stopTimerPolling();
  const verify=async()=>{
    await host.assertPasswordRotationSources(snapshot);
    assert.equal(await host.passwordRotationDatabaseId(),snapshot.databaseId);
    await host.verifyWriterUnits(state);
    await controller.assertServing(state,state.journal.active.slot,state.installed);
    assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during rotation');
  };
  await applyPostgresAppPassword({state,host,snapshot,password,recovering,verify});
  await restoreTimerPolling(marker.timer);
  await clearBackupIntent(markerPath);
  await rm(rotationSnapshotRoot(config,marker.operationId),{recursive:true,force:true}).catch(()=>{});
}

async function recoverPasswordRotation({config,store,publicKey,marker,markerPath}){
  const state=await loadControllerState(config.stateFile);
  const {snapshot,password}=await loadPasswordRotationSnapshot({config,state,marker});
  const host=new PodmanStandaloneHost(config);
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await finishRotation({config,host,controller,state,marker,markerPath,snapshot,password,recovering:true});
}

async function clearPreflightPasswordSnapshot({config,marker,markerPath}){
  const root=rotationSnapshotRoot(config,marker.operationId);
  let info;
  try{info=await lstat(marker.previousPasswordFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(info){
    assert.ok(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600,'Preflight password snapshot is not private');
    if(typeof process.getuid==='function')assert.equal(info.uid,process.getuid(),'Preflight password snapshot owner drift');
    assert.equal(path.dirname(marker.previousPasswordFile),root,'Preflight password snapshot escaped its fixed directory');
    await unlink(marker.previousPasswordFile);
    const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
  }
  await clearBackupIntent(markerPath);
  await rm(root,{recursive:true,force:true}).catch(()=>{});
}
async function finalizePreflightPasswordRotation({config,store,publicKey,marker,markerPath,state,expectedDigest}){
  const {snapshot,controllerState}=await loadPreflightPasswordRotationSnapshot({config,state,marker});
  assert.equal(createHash('sha256').update(JSON.stringify(controllerState)).digest('hex'),marker.rotation.controllerDigest,
    'Preflight-password controller identity changed');
  await assertRotationControlUnits(config);
  await stopTimerPolling();
  const host=new PodmanStandaloneHost(config);
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  await host.ensurePreflightPasswordRotationDatabase(snapshot);
  await host.verifyPostgresPreflightPasswordDigest(snapshot,expectedDigest);
  const route=await readFile(config.routeFile,'utf8');
  assert.ok(route===marker.routeContent||route==='blocked\n','Preflight-password recovery route differs from its snapshot');
  if(route==='blocked\n')await recoverProbeCredentialWriter({host,state});
  await host.route(marker.routeContent.trim());
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during preflight-password completion');
  if(state.paused!==controllerState.paused)await store.save(withPause(state,controllerState.paused));
  assert.deepEqual(await loadControllerState(config.stateFile),controllerState,
    'Preflight-password completion did not restore the original pause state');
  assert.equal(await readFile(config.routeFile,'utf8'),marker.routeContent,'Preflight-password completion did not restore the route');
  await restoreTimerPolling(marker.timer);
  await clearPreflightPasswordSnapshot({config,marker,markerPath});
}
async function rollbackPreflightPasswordRotation({config,store,publicKey,marker,markerPath,state,controllerState,snapshot,previousPassword}){
  await assertRotationControlUnits(config);
  await stopTimerPolling();
  const host=new PodmanStandaloneHost(config);
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  const observed=await host.observe();
  assert.equal(observed.route,'blocked','Preflight-password rollback requires blocked admission');
  if(observed.writers.length){
    assert.deepEqual(observed.writers,[{slot:state.journal.active.slot,image:state.installed.image}],
      'Unexpected writer prevents preflight-password rollback');
    await host.assertNoWriterContainers(state.journal.active.slot);
    await host.stopWriter(state.journal.active.slot);
  }
  await host.assertNoWriterContainers();
  await host.ensurePreflightPasswordRotationDatabase(snapshot);
  await host.changePostgresPreflightPassword(previousPassword);
  await host.replacePostgresPreflightSecret(previousPassword,snapshot);
  await host.verifyPostgresPreflightPassword(previousPassword);
  await host.assertPreflightPasswordRotationSources(snapshot);
  const route=await readFile(config.routeFile,'utf8');
  assert.ok(route===marker.routeContent||route==='blocked\n','Preflight-password recovery route differs from its snapshot');
  await host.startWriter(state.journal.active.slot,state.installed);
  await host.verifyBlockedPasswordRotation(state.journal.active.slot,state.installed);
  await host.route(marker.routeContent.trim());
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during preflight-password rollback');
  if(state.paused!==controllerState.paused)await store.save(withPause(state,controllerState.paused));
  assert.deepEqual(await loadControllerState(config.stateFile),controllerState,
    'Preflight-password rollback did not restore the original pause state');
  assert.equal(await readFile(config.routeFile,'utf8'),marker.routeContent,'Preflight-password rollback did not restore the route');
  marker.phase='rolled-back';
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  await restoreTimerPolling(marker.timer);
  await clearPreflightPasswordSnapshot({config,marker,markerPath});
}
async function recoverPreflightPasswordRotation({config,store,publicKey,marker,markerPath}){
  const state=await loadControllerState(config.stateFile);
  if(marker.phase==='completed'||marker.phase==='rolled-back'){
    const expectedDigest=marker.phase==='completed'?marker.rotation.replacementDigest:marker.rotation.previousDigest;
    await finalizePreflightPasswordRotation({config,store,publicKey,marker,markerPath,state,expectedDigest});
  }else{
    const {snapshot,controllerState,previousPassword}=await loadPreflightPasswordRotationSnapshot({config,state,marker});
    assert.ok(previousPassword,'Applying preflight-password rotation lacks its rollback credential');
    await rollbackPreflightPasswordRotation({config,store,publicKey,marker,markerPath,state,controllerState,snapshot,previousPassword});
  }
}

async function restoreTunnelTokenRotation({config,store,publicKey,marker,markerPath,state,snapshot,previousToken}){
  await assertRotationControlUnits(config);
  await stopTimerPolling();
  const host=new PodmanStandaloneHost(config);
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  const observedRoute=(await readFile(config.routeFile,'utf8'));
  assert.ok(observedRoute===marker.routeContent||observedRoute==='blocked\n','Tunnel recovery route differs from its recorded state');
  await host.installTunnelRotationStartupFence();
  const secret=await host.assertTunnelTokenRotationSources(snapshot);
  const active=await host.tunnelRotationServiceActive();
  if(secret){
    const digest=[snapshot.previousDigest,snapshot.replacementDigest]
      .find(expected=>matchesRotationCredential(secret.token,snapshot.operationId,expected));
    assert.ok(digest,'Tunnel recovery found an unrecognized token');
    if(active)await host.verifyTunnelTokenRotation(snapshot,digest);
  }else assert.equal(active,false,'Tunnel service is active while its canonical token secret is missing');
  if(active)await host.stopTunnel();
  await host.assertTunnelStoppedForRotation(snapshot);
  await host.replaceTunnelToken(previousToken,snapshot);
  await host.assertTunnelStoppedForRotation(snapshot);
  await host.startTunnelForRotation(snapshot);
  await host.verifyTunnelTokenRotation(snapshot,snapshot.previousDigest);
  await host.route(marker.routeContent.trim());
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during Tunnel token recovery');
  assert.equal((await readFile(config.routeFile,'utf8')),marker.routeContent,'Tunnel recovery did not restore the recorded route');
  marker.phase='rolled-back';
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  await restoreTimerPolling(marker.timer);
  await rm(rotationSnapshotRoot(config,marker.operationId),{recursive:true,force:true}).catch(()=>{});
  await host.removeTunnelRotationStartupFence();
  await clearBackupIntent(markerPath);
}
async function recoverTunnelTokenRotation({config,store,publicKey,marker,markerPath}){
  const state=await loadControllerState(config.stateFile);
  if(marker.phase==='completed'){
    await finalizeTunnelTokenRotation({config,store,publicKey,marker,markerPath,state,expectedDigest:marker.rotation.replacementDigest});
    return;
  }
  if(marker.phase==='rolled-back'){
    await finalizeTunnelTokenRotation({config,store,publicKey,marker,markerPath,state,expectedDigest:marker.rotation.previousDigest});
    return;
  }
  const {snapshot,previousToken}=await loadTunnelTokenSnapshot({config,state,marker});
  await restoreTunnelTokenRotation({config,store,publicKey,marker,markerPath,state,snapshot,previousToken});
}
async function finalizeTunnelTokenRotation({config,store,publicKey,marker,markerPath,state,expectedDigest}){
  const {root,rotation}=validateTunnelTokenRotationMarker(marker,config);
  assertTunnelTokenRotationState(state);
  assert.equal(createHash('sha256').update(JSON.stringify(state)).digest('hex'),rotation.controllerDigest,'Tunnel completion controller identity changed');
  await assertRotationControlUnits(config);
  await stopTimerPolling();
  const host=new PodmanStandaloneHost(config);
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  const route=await readFile(config.routeFile,'utf8');
  assert.ok(route===marker.routeContent||route==='blocked\n','Tunnel completion route differs from its snapshot');
  await host.installTunnelRotationStartupFence();
  const secret=await host.assertTunnelTokenRotationSources(rotation);
  assert.ok(secret&&matchesRotationCredential(secret.token,rotation.operationId,expectedDigest),
    'Tunnel token does not match its durable terminal marker');
  if(await host.tunnelRotationServiceActive())await host.verifyTunnelTokenRotation(rotation,expectedDigest);
  else{
    await host.assertTunnelStoppedForRotation(rotation);
    await host.startTunnelForRotation(rotation);
    await host.verifyTunnelTokenRotation(rotation,expectedDigest);
  }
  await host.route(marker.routeContent.trim());
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during Tunnel completion recovery');
  assert.equal(await readFile(config.routeFile,'utf8'),marker.routeContent,'Tunnel completion recovery did not restore the recorded route');
  await rm(root,{recursive:true,force:true}).catch(()=>{});
  await restoreTimerPolling(marker.timer);
  await host.removeTunnelRotationStartupFence();
  await clearBackupIntent(markerPath);
}
async function rotateTunnelToken({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath}){
  assertTunnelTokenRotationState(state);
  const {tunnelTokenFile}=validateTunnelTokenRotationManifest(manifest,manifestPath,serviceHome);
  assert.equal(path.dirname(config.publicKeyFile),path.dirname(manifest.configPath),'Tunnel token candidate belongs to another controller');
  const root=path.resolve(manifest.candidateRoot);
  assert.equal(await realpath(root),root,'Tunnel token staging root must not traverse a symlink');
  assert.equal((await lstat(root)).mode&0o777,0o700,'Tunnel token staging root must be private');
  await readBoundedPrivateFile(manifestPath,65536);
  const replacement=validateTunnelToken(await readBoundedPrivateFile(tunnelTokenFile,8193));
  assert.equal(fileURLToPath(import.meta.url),path.join(manifest.sourceDir,'deploy/updater/standalone-maintenance.mjs'),
    'Install the reviewed updater before rotating the Tunnel token');
  const host=new PodmanStandaloneHost(config);
  assert.ok(host.runtime,'Tunnel token rotation requires a typed runtime');
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await controller.assertNoBackupIntent();
  await assertRotationControlUnits(config);
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  const snapshot=await host.captureTunnelTokenRotation(replacement,randomUUID(),state);
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed before Tunnel token admission');
  const initialRoute=await readFile(config.routeFile,'utf8');
  assert.equal(initialRoute,`${state.journal.active.slot}\n`,'Tunnel token rotation requires the exact committed route');
  const initialTimer=timerState();
  assert.equal(updaterServiceState(),'inactive','Updater poll service must be idle before Tunnel token rotation');
  const marker=await saveTunnelTokenSnapshot({config,state,snapshot,previousToken:(await host.assertTunnelTokenRotationSources(snapshot)).token,
    timer:initialTimer,routeContent:initialRoute});
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  try{
    await stopTimerPolling();
    await host.installTunnelRotationStartupFence();
    await host.assertTunnelTokenRotationSources(snapshot);
    await host.stopTunnel();
    await host.assertTunnelStoppedForRotation(snapshot);
    await host.replaceTunnelToken(replacement,snapshot);
    await host.startTunnelForRotation(snapshot);
    await host.verifyTunnelTokenRotation(snapshot,snapshot.replacementDigest);
    await controller.assertServing(state,state.journal.active.slot,state.installed);
    assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during Tunnel token rotation');
    assert.equal(await readFile(config.routeFile,'utf8'),initialRoute,'Tunnel token rotation changed the committed route');
    marker.phase='completed';
    await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
    await rm(rotationSnapshotRoot(config,marker.operationId),{recursive:true,force:true}).catch(()=>{});
    await restoreTimerPolling(initialTimer);
    await host.removeTunnelRotationStartupFence();
    await clearBackupIntent(markerPath);
    return {format:'codexia-updater-maintenance/v1',tunnelTokenRotated:true};
  }catch(rotationError){
    const durableMarker=await readTransaction(markerPath).catch(()=>null);
    if(marker.phase==='completed'&&durableMarker===null)
      throw Error('Tunnel token rotation committed but its startup fence cleanup failed',{cause:rotationError});
    try{await recoverInterrupted(config,store,markerPath,publicKey);}
    catch(recoveryError){throw new AggregateError([rotationError,recoveryError],'Tunnel token rotation rollback could not be verified; recovery remains blocked');}
    if(durableMarker?.format===tunnelTokenRotationFormat&&durableMarker.phase==='completed')
      return {format:'codexia-updater-maintenance/v1',tunnelTokenRotated:true,recoveredCompletion:true};
    throw Error('Tunnel token rotation failed; the prior token and Tunnel service were restored',{cause:rotationError});
  }
}

async function finishApiAuthTokenRotation({config,state,host,controller,marker,markerPath,snapshot,previousToken,replacementToken,recovering}){
  await assertRotationControlUnits(config);
  await stopTimerPolling();
  if(recovering){
    await recoverApiAuthTokenWriter({host,controller,state,snapshot,previousToken,replacementToken});
    assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during API token recovery');
    await restoreTimerPolling(marker.timer);
    marker.phase='rolled-back';
    await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
    await clearApiAuthTokenRotationSnapshot({config,marker,markerPath}).catch(()=>undefined);
  }else{
    const verify=async()=>{
      host.assertApiAuthTokenSecret(snapshot);
      await host.verifyWriterUnits(state);
      await controller.assertServing(state,state.journal.active.slot,state.installed);
      assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during API token rotation');
    };
    await transitionAuthTokenWriter({host,state,oldToken:previousToken,newToken:replacementToken,snapshot,verify});
    assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during API token rotation');
    await restoreTimerPolling(marker.timer);
    marker.phase='completed';
    await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
    // A SIGKILL after the durable completion marker is finalized by boot
    // recovery against the replacement secret; rollback credentials are no
    // longer needed after both direct auth probes and serving readiness pass.
    await clearApiAuthTokenRotationSnapshot({config,marker,markerPath}).catch(()=>undefined);
  }
}

async function clearApiAuthTokenRotationSnapshot({config,marker,markerPath}){
  const root=rotationSnapshotRoot(config,marker.operationId);
  for(const filename of [marker.rotation.previousTokenFile,marker.rotation.replacementTokenFile]){
    assert.equal(path.dirname(filename),root,'API token snapshot file escaped its fixed directory');
    let info;
    try{info=await lstat(filename);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    assert.ok(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600,'API token snapshot file is not private');
    if(typeof process.getuid==='function')assert.equal(info.uid,process.getuid(),'API token snapshot owner drift');
    await unlink(filename);
  }
  const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
  await clearBackupIntent(markerPath);
  await rm(root,{recursive:true,force:true}).catch(()=>{});
}

async function completeApiAuthTokenRotation({config,state,host,controller,marker,markerPath,rotation,expectedDigest}){
  await assertRotationControlUnits(config);
  await stopTimerPolling();
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(rotation.slot);
  host.assertApiAuthTokenSecret(rotation,expectedDigest);
  const observed=await host.observe();
  assert.equal(observed.route,'blocked','Completed API token recovery requires blocked admission');
  if(observed.writers.length){
    assert.deepEqual(observed.writers,[{slot:rotation.slot,image:rotation.releaseImage}],'Unexpected writer prevents completed API token recovery');
    await host.assertNoWriterContainers(rotation.slot);
  }else{
    await host.assertNoWriterContainers();
    await host.startWriter(rotation.slot,state.installed);
  }
  await host.verifyWriterUnits(state);
  await host.verifyMountedApiAuthToken(rotation.slot);
  await host.route(rotation.slot);
  await controller.assertServing(state,rotation.slot,state.installed);
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during completed API token recovery');
  await restoreTimerPolling(marker.timer);
  await clearApiAuthTokenRotationSnapshot({config,marker,markerPath});
}

async function recoverApiAuthTokenRotation({config,store,publicKey,marker,markerPath}){
  const state=await loadControllerState(config.stateFile);
  const host=new PodmanStandaloneHost(config);
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  if(marker.phase==='completed'||marker.phase==='rolled-back'){
    const {rotation}=await validateApiAuthTokenSnapshotIdentity({config,state,marker});
    await completeApiAuthTokenRotation({config,state,host,controller,marker,markerPath,rotation,
      expectedDigest:marker.phase==='completed'?rotation.replacementDigest:rotation.previousDigest});
  }else{
    const {snapshot,previousToken,replacementToken}=await loadApiAuthTokenSnapshot({config,state,marker});
    await finishApiAuthTokenRotation({config,state,host,controller,marker,markerPath,snapshot,previousToken,replacementToken,recovering:true});
  }
}

async function rotateApiAuthToken({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath}){
  assertApiTokenRotationState(state);
  validateApiAuthTokenRotationManifest(manifest,manifestPath,serviceHome);
  assert.equal(path.dirname(config.publicKeyFile),path.dirname(manifest.configPath),'Candidate belongs to another controller');
  assert.equal(config.quadletDirectory,path.join(serviceHome,'.config','containers','systemd'));
  const root=path.resolve(manifest.candidateRoot);
  assert.equal(await realpath(root),root,'API token staging root must not traverse a symlink');
  assert.equal((await lstat(root)).mode&0o777,0o700,'API token staging root must be private');
  await readBoundedPrivateFile(manifestPath,65536);
  const replacementToken=validateStandaloneAuthToken(await readBoundedPrivateFile(manifest.apiAuthTokenFile,8193));
  assert.equal(fileURLToPath(import.meta.url),path.join(manifest.sourceDir,'deploy/updater/standalone-maintenance.mjs'),
    'Install the reviewed updater before rotating the API token');
  const host=new PodmanStandaloneHost(config);
  assert.ok(host.runtime,'API token rotation requires a typed writer runtime');
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await controller.assertNoBackupIntent();
  await assertRotationControlUnits(config);
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  const snapshot=await host.captureApiAuthTokenRotation(replacementToken,randomUUID(),state);
  const previousToken=snapshot.token;
  delete snapshot.token;
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed before API token rotation');
  assert.equal(updaterServiceState(),'inactive','Polling must be idle at API token rotation admission');
  const marker=await saveApiAuthTokenSnapshot({config,state,snapshot,previousToken,replacementToken,timer:timerState()});
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  try{
    await finishApiAuthTokenRotation({config,state,host,controller,marker,markerPath,snapshot,previousToken,replacementToken,recovering:false});
  }catch(rotationError){
    try{await recoverInterrupted(config,store,markerPath,publicKey);}
    catch(recoveryError){throw new AggregateError([rotationError,recoveryError],'API token rotation rollback could not be verified; recovery remains blocked');}
    try{
      await host.verifyApiAuthToken(state.journal.active.slot,replacementToken,200);
      await controller.assertServing(state,state.journal.active.slot,state.installed);
      return {format:'codexia-updater-maintenance/v1',apiAuthTokenRotated:true,recoveredCompletion:true};
    }catch{
      try{await host.verifyApiAuthToken(state.journal.active.slot,previousToken,200);}
      catch(recoveryError){throw new AggregateError([rotationError,recoveryError],'API token rotation outcome could not be verified; recovery remains blocked');}
    }
    throw Error('API token rotation failed; the previous token and serving release were restored',{cause:rotationError});
  }
  return {format:'codexia-updater-maintenance/v1',apiAuthTokenRotated:true};
}

async function rotatePostgresPreflightPassword({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath}){
  assertPreflightPasswordRotationState(state);
  const {preflightPasswordFile,restoreReceiptFile,databaseQuadletFile}=validatePreflightPasswordRotationManifest(manifest,manifestPath,serviceHome);
  assert.equal(path.dirname(config.publicKeyFile),path.dirname(manifest.configPath),'Candidate belongs to another controller');
  assert.equal(config.quadletDirectory,path.join(serviceHome,'.config','containers','systemd'));
  const root=path.resolve(manifest.candidateRoot);
  assert.equal(await realpath(root),root,'Preflight-password candidate must not traverse a symlink');
  assert.equal((await lstat(root)).mode&0o777,0o700,'Preflight-password candidate must be private');
  await readBoundedPrivateFile(manifestPath,65536);
  const password=validatePostgresPreflightPassword(await readBoundedPrivateFile(preflightPasswordFile,65)).replace(/\n$/u,'');
  const reviewed=await readBoundedPrivateFile(databaseQuadletFile,65536);
  assert.equal(fileURLToPath(import.meta.url),path.join(manifest.sourceDir,'deploy/updater/standalone-maintenance.mjs'),
    'Install the reviewed updater before rotating the preflight password');
  const host=new PodmanStandaloneHost(config);
  assert.ok(host.runtime,'Preflight password rotation requires a typed writer runtime');
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await controller.assertNoBackupIntent();
  await assertRotationControlUnits(config);
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  const {snapshot,previousPassword}=await host.capturePreflightPasswordRotation(reviewed,password,randomUUID());
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed before preflight rotation admission');
  const routeContent=await readFile(config.routeFile,'utf8');
  assert.equal(routeContent,`${state.journal.active.slot}\n`,'Preflight password rotation requires the exact committed route');
  await checkRotationBackup({stateDir:path.dirname(config.stateFile),receiptFile:restoreReceiptFile,state,host,
    databaseId:snapshot.databaseId,requirePaused:false});
  const initialTimer=timerState();
  assert.equal(updaterServiceState(),'inactive','Polling must be idle at preflight rotation admission');
  const marker=await savePreflightPasswordRotationSnapshot({config,state,snapshot,previousPassword,timer:initialTimer,routeContent});
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  try{
    await stopTimerPolling();
    await host.route('blocked');
    await host.assertPreflightPasswordRotationSources(snapshot);
    const observed=await host.observe();
    assert.deepEqual(observed,{route:'blocked',writers:[{slot:state.journal.active.slot,image:state.installed.image}],},
      'Preflight password rotation could not fence the exact committed writer');
    await host.assertNoWriterContainers(state.journal.active.slot);
    await host.stopWriter(state.journal.active.slot);
    await host.assertNoWriterContainers();
    await host.changePostgresPreflightPassword(password);
    await host.verifyPostgresPreflightPassword(password,{secretRequired:false});
    await host.replacePostgresPreflightSecret(password,snapshot);
    await host.verifyPostgresPreflightPassword(password);
    await host.assertPreflightPasswordRotationSources(snapshot);
    await host.startWriter(state.journal.active.slot,state.installed);
    await host.verifyBlockedPasswordRotation(state.journal.active.slot,state.installed);
    assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed during preflight password rotation');
    marker.phase='completed';
    await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
    await finalizePreflightPasswordRotation({config,store,publicKey,marker,markerPath,state,expectedDigest:snapshot.replacementDigest});
    return {format:'codexia-updater-maintenance/v1',postgresPreflightPasswordRotated:true};
  }catch(rotationError){
    const durable=await readTransaction(markerPath).catch(()=>null);
    if(marker.phase==='completed'&&durable===null)
      return {format:'codexia-updater-maintenance/v1',postgresPreflightPasswordRotated:true,recoveredCompletion:true};
    try{await recoverInterrupted(config,store,markerPath,publicKey);}
    catch(recoveryError){throw new AggregateError([rotationError,recoveryError],
      'Preflight password rotation could not verify its previous credential; recovery remains blocked');}
    if(durable?.format===preflightPasswordRotationFormat&&durable.phase==='completed')
      return {format:'codexia-updater-maintenance/v1',postgresPreflightPasswordRotated:true,recoveredCompletion:true};
    throw Error('Preflight password rotation failed; the prior read-only credential was restored',{cause:rotationError});
  }
}

async function rotatePostgresAppPassword({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath}){
  assertRotationState(state);
  validateAppPasswordRotationManifest(manifest,manifestPath,serviceHome);
  assert.equal(path.dirname(config.publicKeyFile),path.dirname(manifest.configPath),'Candidate belongs to another controller');
  assert.equal(config.quadletDirectory,path.join(serviceHome,'.config','containers','systemd'));
  const root=path.resolve(manifest.candidateRoot);
  assert.equal(await realpath(root),root,'Password staging root must not traverse a symlink');
  assert.equal((await lstat(root)).mode&0o777,0o700,'Password staging root must be private');
  await readBoundedPrivateFile(manifestPath,65536);
  const password=validatePostgresAppPassword(await readBoundedPrivateFile(manifest.appPasswordFile,65));
  const reviewed=await readBoundedPrivateFile(manifest.databaseQuadletFile,65536);
  // Boot must execute this transaction reader after a power loss.
  assert.equal(fileURLToPath(import.meta.url),path.join(manifest.sourceDir,'deploy/updater/standalone-maintenance.mjs'),
    'Install the reviewed updater before rotating the application password');
  const host=new PodmanStandaloneHost(config);
  assert.ok(host.runtime,'Rotation requires a typed writer runtime');
  const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await controller.assertNoBackupIntent();
  await assertRotationControlUnits(config);
  await host.assertRuntimeSources();
  await host.assertInitialLegacyAbsent();
  await host.assertNoPreflight();
  await host.verifyWriterUnits(state);
  await host.assertCommittedWriterUnitSource(state.journal.active.slot);
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  const {snapshot,previousPassword}=await host.capturePasswordRotation(reviewed,password,randomUUID());
  assert.deepEqual(await loadControllerState(config.stateFile),state,'Controller changed before backup admission');
  await checkRotationBackup({stateDir:path.dirname(config.stateFile),receiptFile:manifest.restoreReceiptFile,state,host,databaseId:snapshot.databaseId});
  assert.equal(updaterServiceState(),'inactive','Polling must be idle at rotation admission');
  const marker=await savePasswordRotationSnapshot({config,state,snapshot,previousPassword,timer:timerState()});
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  try{
    await finishRotation({config,state,host,controller,marker,markerPath,snapshot,password,recovering:false});
  }catch(rotationError){
    try{await recoverInterrupted(config,store,markerPath,publicKey);}
    catch(recoveryError){throw new AggregateError([rotationError,recoveryError],'Password rotation could not verify rollback; recovery remains blocked');}
    throw Error('Password rotation failed; the previous app credential and serving release were restored',{cause:rotationError});
  }
  return {format:'codexia-updater-maintenance/v1',postgresAppPasswordRotated:true};
}

export async function maintainStandaloneUpdater({config,manifestPath,publicKey,state,store}){
  assert.equal(path.dirname(config.stateFile),process.env.CODEXIA_UPDATER_LOCK_DIRECTORY,'Maintenance must use the canonical host lock');
  const stateDir=path.dirname(config.stateFile);
  const maintenanceDir=path.join(stateDir,'maintenance');
  const markerPath=path.join(maintenanceDir,'in-progress.json');
  await ensureDirectoryTreeDurable(maintenanceDir);
  const recovered=await recoverInterrupted(config,store,markerPath,publicKey);
  if(recovered){
    state=await loadControllerState(config.stateFile);
    config=JSON.parse(await readFile(path.join(path.dirname(config.publicKeyFile),'config.json'),'utf8'));
  }
  assert.ok(['idle','committed'].includes(state.journal.phase),'Maintenance requires a stable controller checkpoint');
  assert.equal(state.lastError,null,'Maintenance refuses a controller with a recorded error');

  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const serviceHome=path.resolve(config.quadletDirectory,'../../..');
  if(manifest.rotatePostgresPreflightPassword===true){
    return rotatePostgresPreflightPassword({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath});
  }
  if(manifest.rotatePostgresAppPassword===true){
    return rotatePostgresAppPassword({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath});
  }
  if(manifest.rotateTunnelToken===true){
    return rotateTunnelToken({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath});
  }
  if(manifest.rotateApiAuthToken===true){
    return rotateApiAuthToken({config,manifest,manifestPath,serviceHome,state,publicKey,store,markerPath});
  }
  const credentialRotation=manifest.rotateProbeCredentials===true;
  assert.deepEqual(Object.keys(manifest).sort(),['candidateRoot','configPath','format','sourceDir','unitDir',...(credentialRotation?['rotateProbeCredentials']:[])].sort());
  assert.equal(manifest.format,'codexia-updater-maintenance/v1');
  for(const key of ['candidateRoot','configPath','sourceDir','unitDir'])assert.ok(path.isAbsolute(manifest[key]),'Maintenance manifest paths must be absolute');
  const candidateRoot=path.resolve(manifest.candidateRoot);
  assert.equal(path.resolve(manifestPath),path.join(candidateRoot,'manifest.json'),'Maintenance manifest must be staged with its candidate');
  assert.equal(await realpath(candidateRoot),candidateRoot,'Maintenance candidate root cannot traverse a symlink');
  assert.ok(candidateRoot.startsWith(path.join(maintenanceDir,'candidates')+path.sep),'Maintenance candidate must remain in its private staging directory');
  assert.equal(path.resolve(manifest.configPath),path.join(path.dirname(config.publicKeyFile),'config.json'),'Maintenance may update only the canonical private configuration');
  assert.equal(path.resolve(manifest.unitDir),path.join(serviceHome,'.config','systemd','user'),'Maintenance unit directory is outside the service user configuration');
  assert.equal(path.resolve(manifest.sourceDir),'/opt/codexia-updater','Maintenance source directory differs from the canonical installation');

  const candidateConfig=credentialRotation?config:JSON.parse(await readCandidate(candidateRoot,'config.json'));
  const nextConfig=validateMaintenanceConfig(config,candidateConfig);
  const candidateHost=new PodmanStandaloneHost(nextConfig);
  const currentHost=new PodmanStandaloneHost(config);
  const runtimeChanged=!isDeepStrictEqual(config.runtime,nextConfig.runtime);
  if(runtimeChanged)assert.equal(nextConfig.runtime?.profile,state.installed.profile,'Runtime profile changes require a compatible signed release transition');
  await candidateHost.assertRuntimeSources();
  const controller=new StandaloneController({host:candidateHost,store,publicKey,observeMilliseconds:nextConfig.observeMilliseconds??300000});
  const activeSlot=state.journal.active.slot;
  const currentController=new StandaloneController({host:currentHost,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await preflightMaintenanceRuntime({currentConfig:config,nextConfig,currentHost,candidateHost,currentController,candidateController:controller,state,activeSlot});

  const entries=credentialRotation?probeCredentialFiles(config,manifest.configPath):filesFor(manifest,{...config,...nextConfig},candidateConfig);
  const files=await candidateFiles(entries,candidateRoot);
  if(credentialRotation){
    // The installed runtime must already understand this recovery marker.
    // Never combine credential rotation with a source/runtime upgrade.
    assert.equal(fileURLToPath(import.meta.url),path.join(manifest.sourceDir,'deploy/updater/standalone-maintenance.mjs'),
      'Install the reviewed maintenance runtime before rotating credentials');
    assert.ok(currentHost.runtime,'Credential rotation requires the reviewed typed runtime');
    const stagedConfig={...config};
    for(const entry of files){
      validateProbeCredential(entry.content);
      validateProbeCredential(await readRegularFile(entry.target));
      const staged=path.join(candidateRoot,entry.candidate);
      await readRegularFile(staged);
      stagedConfig[entry.key]=staged;
    }
    await assertProbeCredentialAccess(currentHost,state,publicKey);
    await assertProbeCredentialAccess(new PodmanStandaloneHost(stagedConfig),state,publicKey);
  }else{
    const proxyIndex=files.findIndex(entry=>entry.candidate==='quadlet/codexia-api-proxy.container');
    assertProxyImageStable(await readRegularFile(files[proxyIndex].target),files[proxyIndex].content);
  }
  let proxyRestartRequired=false;
  for(const entry of files){
    if(entry.candidate!=='deploy/updater/proxy.mjs'&&entry.candidate!=='quadlet/codexia-api-proxy.container')continue;
    const previous=await readRegularFile(entry.target);
    if(previous!==entry.content)proxyRestartRequired=true;
  }

  const routeContent=await readFile(config.routeFile,'utf8');
  const initialTimer=timerState();
  assert.equal(updaterServiceState(),'inactive','Updater poll service must be idle before maintenance');
  const snapshotRoot=path.join(maintenanceDir,'snapshots',randomUUID());
  await ensureDirectoryTreeDurable(snapshotRoot);
  const records=await snapshotFiles(files.map(({target,allowMissing})=>({target,allowMissing})),snapshotRoot);
  await atomicWrite(path.join(snapshotRoot,'controller.json'),JSON.stringify(state)+'\n');
  const oldSourceRoot=path.join(snapshotRoot,'old-source');
  for(const relative of MAINTENANCE_SOURCE_FILES){
    const oldContent=await readRegularFile(path.join(manifest.sourceDir,relative),{required:relative!=='deploy/updater/standalone-maintenance.mjs'});
    if(oldContent===null)continue;
    const backup=path.join(oldSourceRoot,relative);
    await ensureDirectoryTreeDurable(path.dirname(backup));
    await atomicWrite(backup,oldContent);
  }
  assert.ok(await readFile(path.join(oldSourceRoot,'deploy/updater/standalone-updater.mjs'),'utf8'),'Existing updater entrypoint is required for rollback verification');
  const marker={
    format:'codexia-maintenance-transaction/v1',snapshotRoot,files:records,
    configPath:manifest.configPath,sourceDir:manifest.sourceDir,unitDir:manifest.unitDir,
    stateFile:config.stateFile,routeFile:config.routeFile,routeContent,quadletDir:config.quadletDirectory,
    originalPaused:state.paused,timerState:initialTimer,updaterServiceState:'inactive',proxyRestartRequired,runtimeChanged,
    ...(credentialRotation?{probeCredentialsRotated:true}:{}),
  };
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  try{
    await stopTimerPolling();
    if(!state.paused)await store.save(withPause(state,true));
    await writeCandidates(files);
    run('systemctl',['--user','daemon-reload']);
    await checkFilesApplied(files);
    if(credentialRotation)await assertProbeCredentialAccess(candidateHost,state,publicKey);
    for(const filename of MAINTENANCE_UNIT_FILES){
      const unitName=filename.replace(/\.example$/u,'');
      const target=path.join(manifest.unitDir,filename);
      await assertUnitLoaded(unitName,target);
    }
    if(runtimeChanged){
      await transitionRuntimeWriter({
        currentHost,targetHost:candidateHost,slot:activeSlot,release:state.installed,state,
        verify:async()=>{await candidateHost.verifyWriterUnits(state);await controller.assertServing(state,activeSlot,state.installed);},
      });
    }
    if(proxyRestartRequired)await candidateHost.route('blocked');
    await activateProxyRevision({changed:proxyRestartRequired,restart:restartProxyService,verify:async()=>{}});
    if(proxyRestartRequired)await candidateHost.route(activeSlot);
    await candidateHost.assertRuntimeSources();
    await candidateHost.verifyWriterUnits(state);
    await controller.assertServing(state,activeSlot,state.installed);
    const finalState=await loadControllerState(config.stateFile);
    assertStateExceptPause(state,finalState);
    if(finalState.paused!==state.paused)await store.save(withPause(finalState,state.paused));
    assert.equal(await readFile(config.routeFile,'utf8'),routeContent,'Maintenance changed the active proxy route');
    await restoreTimerPolling(initialTimer);
    await clearBackupIntent(markerPath);
    await rm(snapshotRoot,{recursive:true,force:true}).catch(()=>{});
    return {format:'codexia-updater-maintenance/v1',updatedFiles:files.length,recoveredInterruptedMaintenance:recovered,...(credentialRotation?{probeCredentialsRotated:true}:{})};
  }catch(error){
    try{
      await restoreFiles(records);
      run('systemctl',['--user','daemon-reload']);
      const oldHost=new PodmanStandaloneHost(config);
      if(proxyRestartRequired){
        await oldHost.route('blocked');
        await activateProxyRevision({changed:true,restart:restartProxyService,verify:async()=>{}});
      }
      if(runtimeChanged){
        const oldController=new StandaloneController({host:oldHost,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
        await transitionRuntimeWriter({
          currentHost:candidateHost,targetHost:oldHost,slot:activeSlot,release:state.installed,state,
          verify:async()=>{await oldHost.verifyWriterUnits(state);await oldController.assertServing(state,activeSlot,state.installed);},
        });
      }else if(proxyRestartRequired)await oldHost.route(activeSlot);
      assert.equal(await readFile(config.routeFile,'utf8'),routeContent,'Maintenance changed the active proxy route');
      const currentState=await loadControllerState(config.stateFile);
      assertStateExceptPause(state,currentState);
      await verifyOldCode(marker);
      if(credentialRotation)await assertProbeCredentialAccess(oldHost,state,publicKey);
      if(currentState.paused!==state.paused)await store.save(withPause(currentState,state.paused));
      await restoreTimerPolling(initialTimer);
      await clearBackupIntent(markerPath);
      await rm(snapshotRoot,{recursive:true,force:true});
    }catch(rollbackError){
      const currentState=await loadControllerState(config.stateFile);
      if(currentState.paused!==true)await store.save(withPause(currentState,true));
      await new PodmanStandaloneHost(config).route('blocked').catch(()=>undefined);
      await keepTimerStopped().catch(()=>undefined);
      throw new Error('Updater maintenance failed and rollback remains blocked for recovery: '+String(rollbackError.message??rollbackError));
    }
    throw new Error('Updater maintenance failed; previous source/config/units were restored: '+String(error.message??error));
  }
}
