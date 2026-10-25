import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { namedSavePointCapacityFlow } from './namedSavePointCapacityFlow.js';
import { launchDesktop } from './electronAppFlow.js';
import { namedSavePointsAssemblyFlow, namedSavePointsDrawingFlow, namedSavePointsPartFlow, readSavePointColdArchive, assertSavePointProcessCold, readSavePointProcessOwner, readSavePointBuildPins, attachSavePointColdArchives, observeSavePointNetwork, writeSavePointEvidence } from './namedSavePointsFlow.js';

async function run(playwright: Parameters<typeof launchDesktop>[0], info: Parameters<typeof launchDesktop>[1],
  flow: (page: Page, app: ElectronApplication) => Promise<void>, kind: 'part' | 'assembly' | 'drawing'): Promise<void> {
  const buildPins = await readSavePointBuildPins();
  const { app } = await launchDesktop(playwright, info);
  const firstNetwork = observeSavePointNetwork(app.context(), info, 'r16-network-before-cold');
  let pid: number; let profile: string; let oldOwner: NonNullable<Awaited<ReturnType<typeof readSavePointProcessOwner>>>;
  const child = app.process();
  try {
  const actualPid = child.pid;
  if (actualPid === undefined) throw new Error('Actual Electron PID missing');
  pid = actualPid;
  profile = await app.evaluate(({ app: nativeApp }) => nativeApp.getPath('userData'));
  const observedOwner = await readSavePointProcessOwner(profile, pid);
  if (observedOwner === null) throw new Error('Actual Electron creation identity missing');
  oldOwner = observedOwner;
  } catch (error) { await app.close(); throw error; }
  let archive: Awaited<ReturnType<typeof readSavePointColdArchive>>;
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await flow(page, app); expect(errors).toEqual([]);
    archive = await readSavePointColdArchive(page); await attachSavePointColdArchives(info, archive);
  } finally { try { await app.close(); } finally { await firstNetwork.finish(); } }
  await expect.poll(() => readSavePointProcessOwner(profile, pid), { message: 'Old Electron PID/creation exited' }).toBeNull();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  const { app: fresh } = await launchDesktop(playwright, info);
  const secondNetwork = observeSavePointNetwork(fresh.context(), info, 'r16-network-after-cold');
  try {
    const newPid = fresh.process().pid;
    if (newPid === undefined) throw new Error('Actual restarted Electron PID missing');
    const newProfile = await fresh.evaluate(({ app: nativeApp }) => nativeApp.getPath('userData'));
    expect(newProfile).toBe(profile);
    const newOwner = await readSavePointProcessOwner(newProfile, newPid);
    if (newOwner === null) throw new Error('Actual restarted Electron creation identity missing');
    expect(JSON.stringify(newOwner)).not.toBe(JSON.stringify(oldOwner));
    expect(await readSavePointBuildPins()).toBe(buildPins);
    const page = await fresh.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await assertSavePointProcessCold(page, archive, kind); expect(errors).toEqual([]);
    await writeSavePointEvidence(info, 'r16-electron-process-cold', { kind, profile, oldOwner, newOwner,
      oldClosed: true, buildAndSourceSha256: buildPins, shelfMetadataAndEveryChunkByteEqual: true });
  } finally { try { await fresh.close(); } finally { await secondNetwork.finish(); } }

}

test('R16 実Electronで部品の名前付き保存点を作り、複製・比較・復元とUndo1回を通す', async ({ playwright }, info) => {
  await run(playwright, info, (page, app) => namedSavePointsPartFlow(page, app), 'part');
});

test('R16 実Electronで組立の名前付き保存点を作り、複製・比較・復元を通す', async ({ playwright }, info) => {
  await run(playwright, info, page => namedSavePointsAssemblyFlow(page), 'assembly');
});

test('R16 実Electronで図面の名前付き保存点を作り、複製・比較・復元を通す', async ({ playwright }, info) => {
  await run(playwright, info, page => namedSavePointsDrawingFlow(page), 'drawing');
});

test('実Electron R16 実100保存点から101件目の作成と複製を拒否し、既存全byteを自動削除せず保持する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const { namedSavePointsCountLimitFlow } = await import('./namedSavePointsFlow.js');
    await namedSavePointsCountLimitFlow(page, info);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

async function runShared(playwright: Parameters<typeof launchDesktop>[0], info: Parameters<typeof launchDesktop>[1]): Promise<void> {
  const { namedSavePointsSharedAssetFlow, assertSharedSavePointCold } = await import('./namedSavePointsFlow.js');
  const buildPins = await readSavePointBuildPins();
  const { app } = await launchDesktop(playwright, info);
  const firstNetwork = observeSavePointNetwork(app.context(), info, 'r16-network-before-cold');
  let pid: number; let profile: string; let oldOwner: NonNullable<Awaited<ReturnType<typeof readSavePointProcessOwner>>>;
  const child = app.process();
  try {
  const actualPid = child.pid;
  if (actualPid === undefined) throw new Error('Actual Electron PID missing');
  pid = actualPid;
  profile = await app.evaluate(({ app: nativeApp }) => nativeApp.getPath('userData'));
  const observedOwner = await readSavePointProcessOwner(profile, pid);
  if (observedOwner === null) throw new Error('Actual Electron creation identity missing');
  oldOwner = observedOwner;
  } catch (error) { await app.close(); throw error; }
  let archive: Awaited<ReturnType<typeof readSavePointColdArchive>>, fixture: Awaited<ReturnType<typeof namedSavePointsSharedAssetFlow>>;
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    fixture = await namedSavePointsSharedAssetFlow(page, info, app); expect(errors).toEqual([]);
    archive = await readSavePointColdArchive(page); await attachSavePointColdArchives(info, archive);
  } finally { try { await app.close(); } finally { await firstNetwork.finish(); } }
  await expect.poll(() => readSavePointProcessOwner(profile, pid), { message: 'Old Electron PID/creation exited' }).toBeNull();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  const { app: fresh } = await launchDesktop(playwright, info);
  const secondNetwork = observeSavePointNetwork(fresh.context(), info, 'r16-network-after-cold');
  try {
    const newPid = fresh.process().pid;
    if (newPid === undefined) throw new Error('Actual restarted Electron PID missing');
    const newProfile = await fresh.evaluate(({ app: nativeApp }) => nativeApp.getPath('userData'));
    expect(newProfile).toBe(profile);
    const newOwner = await readSavePointProcessOwner(newProfile, newPid);
    if (newOwner === null) throw new Error('Actual restarted Electron creation identity missing');
    expect(JSON.stringify(newOwner)).not.toBe(JSON.stringify(oldOwner));
    expect(await readSavePointBuildPins()).toBe(buildPins);
    const page = await fresh.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await assertSharedSavePointCold(page, fixture, info, fresh); expect(errors).toEqual([]);
    await writeSavePointEvidence(info, 'r16-electron-process-cold', { kind: 'nonempty-shared-assembly', profile, oldOwner, newOwner,
      oldClosed: true, buildAndSourceSha256: buildPins, shelfMetadataAndEveryChunkByteEqual: true });
  } finally { try { await fresh.close(); } finally { await secondNetwork.finish(); } }

}

test('実Electron R16 非空2コンポーネント同1部品参照の実PNG共有保存点を別processで復元し全文書添付とUndo1回を保持する', async ({ playwright }, info) => {
  await runShared(playwright, info);
});

test('実Electron R16 実一意blob512MiB超過の作成を拒否し、既存全byteと全文書添付Undoを保持し複製は追加実体0で成功する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await namedSavePointCapacityFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
