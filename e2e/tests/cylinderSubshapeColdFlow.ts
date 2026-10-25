/// <reference lib="dom" />
import { isDeepStrictEqual } from 'node:util';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { PcadAttachments } from '../../packages/io/src/index.js';
import { readPcadaFile, readArchive, PCAD_DOCUMENT_ENTRY, zipPcadEntries, FIXED_ENTRY_MTIME, type PcadZipEntries } from '../../packages/io/src/index.js';
import { resolveSubShapeReference } from '../../packages/model/src/kernelBridge/referenceResolution.js';
import { applyPlacementToPoint, applyPlacementToDirection, type Quaternion } from '../../packages/model/src/assembly/placementMath.js';
import type { Vec3 } from '../../packages/model/src/sketch/vec3.js';
import { chooseToolMenuItem, installAssemblyFileGateway, resetAssemblyFileGateway, readAssemblyStats,
  type AssemblyBrowserStats } from './assemblyTestSupport.js';
import { startNewAssemblyCapture, placeQueuedPartCapture } from './assemblyCaptureSupport.js';
import { drawRectangle, makeFace, extrudeFace } from './solidCaptureSupport.js';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { readPcadFile } from '../../packages/io/src/index.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { createDirectKernelBridge } from '../../packages/model/src/kernelBridge.js';
import { resolvePart } from '../../packages/model/src/part/resolvePart.js';
import type { PartDocument } from '../../packages/model/src/part/types.js';
import { canonicalPartDocumentText } from '../../packages/model/src/assembly/partLibrary.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverInputs, popoverTitle,
  propertyPanel, selectionKindLabel, sketchTool, treeRow } from './solidCaptureSupport.js';

export type CylinderColdOperation = 'hole' | 'threadShaft';

export interface SavedCylinderColdScenario {
  readonly path: string;
  readonly operation: CylinderColdOperation;
  readonly originalFeatureId: string;
  readonly otherFeatureId: string;
  readonly operationFeatureId: string;
  readonly savedFace: import('../../packages/model/src/geometry/subShapeRef.js').SubShapeRef;
  readonly originalDocument: PartDocument;
  nativeVolume: number | null;
}

const RADIUS = 3;
const HEIGHT = 20;
const ROLES = [
  'cylinder-edge:end-ring', 'cylinder-edge:seam', 'cylinder-edge:start-ring',
  'cylinder-face:end', 'cylinder-face:side', 'cylinder-face:start',
  'cylinder-vertex:seam-end', 'cylinder-vertex:seam-start',
].sort();

async function placeCylinder(page: Page, name: string): Promise<void> {
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '円柱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('円柱を置く');
  await fillFields(page, [String(RADIUS), String(HEIGHT)]);
  const token = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, token);
  if (await popover(page).count() > 0) await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, name)).toBeVisible();
  await waitForSettledRecompute(page);
}

async function makeHole(page: Page, faceZ = HEIGHT): Promise<void> {
  await sketchTool(page, '選択').click();
  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await popoverInputs(page).first().press('Escape');
  await expect(treeRow(page, '点1')).toBeVisible();
  await openToolMenu(page, '加工');
  const hole = toolMenuPanel(page, '加工').getByRole('button', { name: '穴', exact: true });
  await expect(hole).toBeDisabled();
  await hole.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [0, 0, faceZ]);
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(hole).toBeEnabled();
  await hole.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await fillFields(page, ['2']);
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  const token = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, token);
  await expect(treeRow(page, '穴1')).toBeVisible();
}

async function makeThreadShaft(page: Page): Promise<void> {
  await openToolMenu(page, '加工');
  const shaft = toolMenuPanel(page, '加工').getByRole('button', { name: '外ねじ', exact: true });
  await expect(shaft).toBeDisabled();
  await shaft.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  const angle = -Math.PI / 4;
  await clickWorldPoint(page, [RADIUS * Math.cos(angle), RADIUS * Math.sin(angle), HEIGHT / 2]);
  await openToolMenu(page, '加工');
  await expect(shaft).toBeEnabled();
  await shaft.click();
  await expect(popoverTitle(page)).toHaveText('外ねじの大きさ');
  await expect(popover(page).locator('.pcad-menu__count')).toHaveText('M6');
  const token = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, token);
  await expect(treeRow(page, '外ねじ1')).toBeVisible();
}


/** Exact bytes fail with scalar diagnostics before Playwright formats a large array diff. */
function assertExactBinary(actual: Uint8Array | undefined, expected: Uint8Array, label: string): void {
  expect(actual === undefined, `${label}: missing bytes`).toBe(false);
  if (actual === undefined) throw new Error(`${label}: missing bytes`);
  expect(actual.byteLength, `${label}: byte length`).toBe(expected.byteLength);
  expect(Buffer.compare(actual, expected), `${label}: exact byte comparison`).toBe(0);
}

function assertAttachmentBinary(actual: ReadonlyMap<string, PcadAttachments>,
  expected: ReadonlyMap<string, PcadAttachments>): void {
  expect(actual.size).toBe(expected.size);
  for (const [ref, attachment] of expected) {
    const current = actual.get(ref);
    expect(current === undefined, `attachment owner ${ref}`).toBe(false);
    if (current === undefined) throw new Error(`Missing attachment owner ${ref}`);
    for (const kind of ['shapes', 'canvases'] as const) {
      expect(current[kind].size).toBe(attachment[kind].size);
      for (const [key, bytes] of attachment[kind])
        assertExactBinary(current[kind].get(key), bytes, `${ref}/${kind}/${key}`);
    }
    expect(current.meshes.size).toBe(attachment.meshes.size);
    for (const [key, mesh] of attachment.meshes) {
      const received = current.meshes.get(key);
      expect(received === undefined, `${ref}/meshes/${key}`).toBe(false);
      if (received === undefined) throw new Error(`Missing mesh ${ref}/${key}`);
      for (const field of ['positions', 'normals', 'indices'] as const) {
        const a = received[field]; const b = mesh[field];
        assertExactBinary(new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
          new Uint8Array(b.buffer, b.byteOffset, b.byteLength), `${ref}/meshes/${key}/${field}`);
      }
    }
  }
}

async function saveUiPart(page: Page, path: string, app?: ElectronApplication): Promise<Uint8Array> {
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Control+Shift+s');
  if (download !== undefined) await (await download).saveAs(path);
  const bytes = app === undefined ? await readFile(path) : await diskFile(path);
  await expect(page.locator('.pcad-statusbar__text')).toContainText('保存しました');
  return bytes;
}

function savedDocument(bytes: Uint8Array) {
  const decoded = readPcadFile(bytes);
  if (!decoded.ok) throw new Error(`通常PCAD ZIPを読めません: ${decoded.error.message}`);
  return decoded.document;
}

function volumeText(page: Page) {
  return propertyPanel(page).locator('dt.pcad-properties__key')
    .filter({ hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]');
}

export async function createCylinderColdScenario(page: Page, info: TestInfo,
  operation: CylinderColdOperation, app?: ElectronApplication): Promise<SavedCylinderColdScenario> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await waitForSettledRecompute(page);
  await placeCylinder(page, '円柱1');
  if (operation === 'hole') await makeHole(page);
  else await makeThreadShaft(page);
  await placeCylinder(page, '円柱2');
  const path = info.outputPath(`cylinder-${operation}-cold.pcad`);
  const document = savedDocument(await saveUiPart(page, path, app));
  const cylinders = document.solids.filter(feature => feature.kind === 'primitive'
    && feature.shape.kind === 'cylinder');
  expect(cylinders).toHaveLength(2);
  const [original, other] = cylinders;
  if (original?.kind !== 'primitive' || original.shape.kind !== 'cylinder'
    || other?.kind !== 'primitive' || other.shape.kind !== 'cylinder') {
    throw new Error('A/B円柱が保存されませんでした');
  }
  expect(original.id).not.toBe(other.id);
  expect([original.shape.radius.value, original.shape.height.value]).toEqual([RADIUS, HEIGHT]);
  expect([other.shape.radius.value, other.shape.height.value]).toEqual([RADIUS, HEIGHT]);
  expect(other.origin).toEqual(original.origin);
  expect(other.axis).toEqual(original.axis);
  const feature = document.solids.find(solid => solid.kind === operation);
  if (feature === undefined || (feature.kind !== 'hole' && feature.kind !== 'threadShaft')) {
    throw new Error('穴/外ねじフィーチャーが保存されませんでした');
  }
  expect(feature.targetFeatureId).toBe(original.id);
  expect(feature.face.bodyFeatureId).toBe(original.id);
  expect(feature.face.origin?.identity).toMatchObject({
    kind: 'cylinder-face', featureId: original.id, role: operation === 'hole' ? 'end' : 'side',
  });
  const plan = resolvePart(document);
  expect(plan.errors).toEqual([]);
  const originalStep = plan.steps.find(step => step.featureId === original.id);
  const otherStep = plan.steps.find(step => step.featureId === other.id);
  if (originalStep === undefined || otherStep === undefined) throw new Error('円柱A/Bの再計算段がありません');
  expect(originalStep.key).not.toBe(otherStep.key);
  return { path, operation, originalFeatureId: original.id, otherFeatureId: other.id,
    operationFeatureId: feature.id, savedFace: feature.face, originalDocument: document,
    nativeVolume: null };
}

/** UIの保存ZIPを別の新しいNode native bridge/cacheでも評価する。UI Worker内部の観測ではない。 */
export async function inspectFreshNativeCylinderOrigins(scenario: SavedCylinderColdScenario): Promise<void> {
  const document = savedDocument(await readFile(scenario.path));
  const plan = resolvePart(document);
  expect(plan.errors).toEqual([]);
  const oc = await loadOcctForNode();
  const api = createKernelApi(() => Promise.resolve(oc));
  const bridge = createDirectKernelBridge(api);
  const result = await bridge.recomputeSolids(plan.steps);
  expect(result.failures).toEqual([]);
  const operationBody = result.bodies.find(body => body.featureId === scenario.operationFeatureId);
  if (operationBody === undefined || !Number.isFinite(operationBody.volume)) {
    throw new Error('新nativeの加工結果体積がありません');
  }
  expect(operationBody.volume).toBeCloseTo((scenario.operation === 'hole' ? 160 : 180) * Math.PI, 5);
  scenario.nativeVolume = operationBody.volume;
  // A is consumed by Hole/ThreadShaft and therefore absent from visible bodies.
  // Read both owner-tagged primitive meshes from this fresh native cache.
  if (typeof bridge.readCachedBodies !== 'function') {
    throw new Error('新nativeで円柱の保存起点を再読できません');
  }
  const cached = await bridge.readCachedBodies(plan.steps,
    [scenario.originalFeatureId, scenario.otherFeatureId]);
  expect(cached.failures).toEqual([]);
  for (const id of [scenario.originalFeatureId, scenario.otherFeatureId]) {
    const body = cached.bodies.find(candidate => candidate.featureId === id);
    if (body?.origins?.state !== 'tracked') throw new Error(`新nativeの円柱8起点なし: ${id}`);
    const bindings = body.origins.bindings;
    expect(bindings).toHaveLength(8);
    expect(bindings.every(binding => binding.state === 'unique'
      && binding.origin.identity.featureId === id)).toBe(true);
    const roles = bindings.map(binding => {
      const identity = binding.origin.identity;
      if (identity.kind !== 'cylinder-face' && identity.kind !== 'cylinder-edge'
        && identity.kind !== 'cylinder-vertex') throw new Error(`円柱以外の起点: ${id}`);
      return `${identity.kind}:${identity.role}`;
    }).sort();
    expect(roles).toEqual(ROLES);
    const addresses = bindings.map(binding => binding.state === 'unique'
      ? `${binding.current.kind}:${binding.current.index}` : 'not-unique');
    expect(new Set(addresses).size).toBe(8);
  }
}

export async function reopenCylinderColdScenario(page: Page, info: TestInfo,
  scenario: SavedCylinderColdScenario, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  if (app !== undefined) await openTarget(app, scenario.path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== undefined) await (await chooser).setFiles(scenario.path);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
  const name = scenario.operation === 'hole' ? '穴1' : '外ねじ1';
  await expect(treeRow(page, name)).toBeVisible();
  await expect(treeRow(page, '円柱2')).toBeVisible();
  await treeRow(page, name).click();
  if (scenario.nativeVolume === null) throw new Error('保存ZIPの新native計算が未確認です');
  await expect(volumeText(page)).toHaveText(`${expressionValueFromNumber(scenario.nativeVolume).display} mm³`);
  const value = Number((await volumeText(page).textContent())?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
  expect(value).toBeCloseTo((scenario.operation === 'hole' ? 160 : 180) * Math.PI, 5);
  const reopenedPath = info.outputPath(`cylinder-${scenario.operation}-reopened.pcad`);
  const reopened = savedDocument(await saveUiPart(page, reopenedPath, app));
  expect(reopened).toEqual(scenario.originalDocument);
  const feature = reopened.solids.find(solid => solid.id === scenario.operationFeatureId);
  if (feature === undefined || (feature.kind !== 'hole' && feature.kind !== 'threadShaft')) {
    throw new Error('冷再開後に加工フィーチャーがありません');
  }
  expect(feature.kind).toBe(scenario.operation);
  expect(feature.face).toEqual(scenario.savedFace);
  expect(feature.face.bodyFeatureId).toBe(scenario.originalFeatureId);
  expect(feature.face.origin?.identity.featureId).toBe(scenario.originalFeatureId);
  expect(feature.face.origin?.identity.featureId).not.toBe(scenario.otherFeatureId);
  await reorderAndUndoCylinderScenario(page, info, scenario, app);
}

function solidLabels(page: Page): Promise<string[]> {
  return page.locator('.pcad-panel--left .pcad-tree__sections > li')
    .filter({ hasText: 'ソリッド' }).locator('.pcad-tree__row--child .pcad-tree__label').allTextContents();
}

/**
 * R18: フィーチャーの順序を入れ替えても、意味参照は保存した円柱Aの面に対応し続け(誤対応0)、
 * 同じ位置・寸法の円柱Bへ移らない。Undo 1回で文書は元と完全に一致する。
 * 期待値は冷再開と同じ体積(穴160π・化粧ねじ180π)と、保存した面参照の不変。
 */
async function reorderAndUndoCylinderScenario(page: Page, info: TestInfo,
  scenario: SavedCylinderColdScenario, app?: ElectronApplication): Promise<void> {
  const name = scenario.operation === 'hole' ? '穴1' : '外ねじ1';
  const expectedVolume = (scenario.operation === 'hole' ? 160 : 180) * Math.PI;
  await expect.poll(() => solidLabels(page)).toEqual(['円柱1', name, '円柱2']);

  // 円柱2は加工に使われていないので、加工の手前へ移せる(依存は壊れない)。
  await treeRow(page, '円柱2').click({ button: 'right' });
  const moveUp = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '1 つ上へ', exact: true });
  await expect(moveUp).toBeEnabled();
  await moveUp.click();
  await expect.poll(() => solidLabels(page)).toEqual(['円柱1', '円柱2', name]);
  await waitForSettledRecompute(page);
  await treeRow(page, name).click();
  await expect.poll(async () => Number((await volumeText(page).textContent())?.replaceAll(',', '')
    .match(/[\d.]+/u)?.[0] ?? NaN)).toBeCloseTo(expectedVolume, 3);
  const reordered = savedDocument(await saveUiPart(page,
    info.outputPath(`cylinder-${scenario.operation}-reordered.pcad`), app));
  expect(reordered.solids.map(solid => solid.id)).toEqual(
    [scenario.originalFeatureId, scenario.otherFeatureId, scenario.operationFeatureId]);
  const moved = reordered.solids.find(solid => solid.id === scenario.operationFeatureId);
  if (moved === undefined || (moved.kind !== 'hole' && moved.kind !== 'threadShaft')) {
    throw new Error('順序変更後に加工フィーチャーがありません');
  }
  expect(moved.face).toEqual(scenario.savedFace);
  expect(moved.face.origin?.identity.featureId).toBe(scenario.originalFeatureId);
  expect(moved.face.origin?.identity.featureId).not.toBe(scenario.otherFeatureId);

  // Undo 1回で順序が戻り、文書は冷再開直後(=元の保存)と一致する。
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => solidLabels(page)).toEqual(['円柱1', name, '円柱2']);
  await waitForSettledRecompute(page);
  await treeRow(page, name).click();
  await expect.poll(async () => Number((await volumeText(page).textContent())?.replaceAll(',', '')
    .match(/[\d.]+/u)?.[0] ?? NaN)).toBeCloseTo(expectedVolume, 3);
  const undone = savedDocument(await saveUiPart(page,
    info.outputPath(`cylinder-${scenario.operation}-undone.pcad`), app));
  expect(undone).toEqual(scenario.originalDocument);
}

/* ========================================================================== *
 * R18: 履歴(意味起点)のない輸入形状は、指紋補助の参照へ戻って保存・再開できる
 * ========================================================================== */

const IMPORT_BOX_SIZE = 20;
const IMPORT_HOLE_VOLUME = IMPORT_BOX_SIZE ** 3 - Math.PI * 1 ** 2 * IMPORT_BOX_SIZE;

export interface SavedImportedHoleScenario {
  readonly path: string;
  readonly importedFeatureId: string;
  readonly holeFeatureId: string;
  readonly savedFace: import('../../packages/model/src/geometry/subShapeRef.js').SubShapeRef;
  readonly originalDocument: PartDocument;
}

async function exportBoxStep(page: Page, path: string, app?: ElectronApplication): Promise<void> {
  await openToolMenu(page, 'ファイルのほかの操作');
  await toolMenuPanel(page, 'ファイルのほかの操作').getByRole('button', { name: '書き出す', exact: true }).click();
  const panel = page.locator('.pcad-exchange');
  await expect(panel).toBeVisible();
  await panel.getByRole('radio', { name: 'STEP', exact: true }).click();
  if (app !== undefined) {
    await saveTarget(app, path);
    await panel.getByRole('button', { name: '書き出す', exact: true }).click();
    await diskFile(path);
  } else {
    const download = page.waitForEvent('download', { timeout: KERNEL_TIMEOUT_MS });
    await panel.getByRole('button', { name: '書き出す', exact: true }).click();
    await (await download).saveAs(path);
  }
  await expect(panel).toHaveCount(0);
}

/** 箱を置いてSTEPで書き出し、新規の文書へ読み込み直して、輸入形状の上面へ穴をあけて保存する。 */
export async function createImportedHoleScenario(page: Page, info: TestInfo,
  app?: ElectronApplication): Promise<SavedImportedHoleScenario> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await waitForSettledRecompute(page);
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  const placeToken = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, placeToken);
  if (await popover(page).count() > 0) await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await waitForSettledRecompute(page);
  // 書き出しは、押した後に選択・計算の状態が動くと黙って取り消される。箱を選んで落ち着かせてから開く。
  await treeRow(page, '箱1').click();
  await expect(volumeText(page)).toHaveText(`${String(IMPORT_BOX_SIZE ** 3)} mm³`, { timeout: KERNEL_TIMEOUT_MS });
  await waitForSettledRecompute(page);
  const stepPath = info.outputPath('imported-box.step');
  await exportBoxStep(page, stepPath, app);

  await page.addLocatorHandler(page.getByRole('alertdialog', { name: '保存していない変更があります' }),
    async dialog => { await dialog.getByRole('button', { name: '保存せずに続ける', exact: true }).click(); });
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');

  if (app !== undefined) await openTarget(app, stepPath);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await openToolMenu(page, 'ファイルのほかの操作');
  await toolMenuPanel(page, 'ファイルのほかの操作').getByRole('button', { name: '読み込む', exact: true }).click();
  await page.getByRole('form', { name: '読み込み', exact: true })
    .getByRole('button', { name: 'ファイルを選ぶ', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(stepPath);
  await expect(page.locator('.pcad-panel--left .pcad-tree__sections > li').filter({ hasText: 'ソリッド' })
    .locator('.pcad-tree__row--child')).toHaveCount(1, { timeout: 120_000 });
  await waitForSettledRecompute(page);

  await makeHole(page, IMPORT_BOX_SIZE / 2);
  const path = info.outputPath('imported-hole-cold.pcad');
  const document = savedDocument(await saveUiPart(page, path, app));
  const imported = document.solids.find(solid => solid.kind === 'importedSolid');
  const hole = document.solids.find(solid => solid.kind === 'hole');
  if (imported === undefined || hole === undefined || hole.kind !== 'hole') {
    throw new Error('輸入形状と穴が保存されませんでした');
  }
  expect(hole.face.bodyFeatureId).toBe(imported.id);
  // 履歴を持たない輸入形状は意味起点を持たず、指紋補助の参照のまま保存される。
  expect(hole.face.origin).toBeUndefined();
  return { path, importedFeatureId: imported.id, holeFeatureId: hole.id, savedFace: hole.face,
    originalDocument: document };
}

/** 新しい画面で開き直し、穴の体積と保存した面参照が変わらないことを確かめる。 */
export async function reopenImportedHoleScenario(page: Page, info: TestInfo,
  scenario: SavedImportedHoleScenario, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  if (app !== undefined) await openTarget(app, scenario.path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== undefined) await (await chooser).setFiles(scenario.path);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
  await expect(treeRow(page, '穴1')).toBeVisible();
  await treeRow(page, '穴1').click();
  await expect.poll(async () => Number((await volumeText(page).textContent())?.replaceAll(',', '')
    .match(/[\d.]+/u)?.[0] ?? NaN)).toBeCloseTo(IMPORT_HOLE_VOLUME, 3);
  const reopened = savedDocument(await saveUiPart(page, info.outputPath('imported-hole-reopened.pcad'), app));
  expect(reopened).toEqual(scenario.originalDocument);
  const hole = reopened.solids.find(solid => solid.id === scenario.holeFeatureId);
  if (hole?.kind !== 'hole') throw new Error('再開後に穴がありません');
  expect(hole.face).toEqual(scenario.savedFace);
  expect(hole.face.origin).toBeUndefined();
}

/** R18 actual viewport selection; no origin target or injected assembly document. */
export interface SavedHoleWallMateScenario {
  readonly path: string;
  readonly inputPartPath: string;
  readonly inputPart: PartDocument;
  readonly holeId: string;
  readonly bundle: Extract<Awaited<ReturnType<typeof readPcadaFile>>, { readonly ok: true }>;
  readonly rawBytes: Uint8Array;
  readonly saveWindow: readonly [number, number];
  readonly independentParts?: readonly SavedHoleWallPart[];
  readonly before: AssemblyBrowserStats;
  readonly solved: AssemblyBrowserStats;
}

async function wallMateStats(page: Page): Promise<AssemblyBrowserStats> {
  const stats = await readAssemblyStats(page);
  expect(stats.components).toHaveLength(2);
  expect(stats.components[0]?.fixed).toBe(true);
  expect(stats.components[1]?.fixed).toBe(false);
  for (const component of stats.components) {
    expect(component.resolved).not.toBeNull();
    expect(component.displayed).toEqual(component.resolved);
    expect(component.resolved?.position.every(Number.isFinite)).toBe(true);
    expect(component.resolved?.rotation.every(Number.isFinite)).toBe(true);
  }
  return stats;
}

async function readWallMateBundle(bytes: Uint8Array) {
  const bundle = await readPcadaFile(bytes);
  if (!bundle.ok) throw new Error(bundle.error.message);
  expect(bundle.document.components).toHaveLength(2);
  expect(bundle.document.mates).toHaveLength(1);
  const mate = bundle.document.mates[0];
  if (mate === undefined) throw new Error('Missing actual concentric mate');
  expect(mate.kind).toBe('concentric');
  expect(mate.suppressed).toBe(false);
  expect(mate.a.componentId).not.toBe(mate.b.componentId);
  for (const target of [mate.a, mate.b]) {
    if (target.kind !== 'subShape') throw new Error('Viewport wall target was replaced by an origin target');
    expect(target.ref.fingerprint.kind).toBe('face');
    if (target.ref.fingerprint.kind !== 'face') throw new Error('Missing face fingerprint');
    expect(target.ref.fingerprint.surfaceKind).toBe('cylinder');
    expect(target.ref.fingerprint.radius).toBeCloseTo(3, 5);
    expect(target.ref.origin?.identity.kind).toBe('hole-face');
    if (target.ref.origin?.identity.kind !== 'hole-face') throw new Error('Missing new-hole semantic wall');
    expect(target.ref.origin.identity.role).toBe('wall');
  }
  return bundle;
}

interface SavedHoleWallPart {
  readonly path: string;
  readonly fileName: string;
  readonly document: PartDocument;
  readonly holeId: string;
  readonly rawSha256: string;
  readonly contentHash: string;
}

/** Repeat real UI actions in a separately created document; no document/ID injection. */
async function buildCurrentHoleWallPart(page: Page): Promise<void> {
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  const plateToken = await beginRecompute(page);
  await extrudeFace(page, '面1', '10');
  await waitForRecompute(page, plateToken);
  await sketchTool(page, '点').click();
  await fillFields(page, ['20', '15', '0']);
  await commitPopover(page);
  await popoverInputs(page).first().press('Escape');
  await openToolMenu(page, '加工');
  await toolMenuPanel(page, '加工').getByRole('button', { name: '穴', exact: true }).click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [20, 15, 10]);
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  const holeTool = toolMenuPanel(page, '加工').getByRole('button', { name: '穴', exact: true });
  await expect(holeTool).toBeEnabled();
  await holeTool.click();
  await fillFields(page, ['6']);
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  const holeToken = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, holeToken);
  await expect(treeRow(page, '穴1')).toBeVisible();
  await treeRow(page, '穴1').click();
  await expect.poll(async () => Math.abs(Number.parseFloat(await volumeText(page).innerText())
    - (12000 - 90 * Math.PI)), { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
}

/** Observe the original real inputs without polling, replaying, or changing application state. */
async function withHoleWallInputObservation(page: Page, info: TestInfo, select: () => Promise<void>): Promise<void> {
  const observation = await page.evaluateHandle(() => {
    const canvas = document.querySelector('canvas.pcad-viewport__canvas');
    const records: Record<string, unknown>[] = [];
    let droppedEvents = 0;
    const describe = (target: EventTarget | null): string | null => target instanceof Element
      ? (target.tagName + '#' + target.id + '.' + target.className).slice(0, 256) : null;
    const read = (name: string, limit: number): Record<string, unknown> => {
      const reader: unknown = Reflect.get(window, name);
      if (typeof reader !== 'function') return { available: false };
      try {
        const value: unknown = Reflect.apply(reader, window, []);
        const text = JSON.stringify(value);
        return { available: true, json: text?.slice(0, limit) ?? null, truncated: (text?.length ?? 0) > limit };
      } catch (error) { return { available: true, error: String(error).slice(0, 1024) }; }
    };
    const snapshot = () => {
      const started = performance.now();
      const dialog = document.querySelector('.pcad-popover[role="dialog"]');
      const items = dialog?.querySelectorAll('li');
      const rect = canvas?.getBoundingClientRect();
      const result = {
        actualEpochMs: Date.now(), actualMonotonicMs: started,
        canvasConnected: canvas?.isConnected ?? false,
        canvasRect: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        activeElement: describe(document.activeElement),
        recompute: read('pcadRecomputeStats', 1024),
        owner: read('pcadViewportAssemblyOwner', 4096),
        render: read('pcadViewportRenderStats', 1024),
        selectedCount: items?.length ?? null,
        selectedItems: Array.from(items ?? []).slice(0, 3).map(item => item.textContent?.slice(0, 512) ?? ''),
        issue: dialog?.querySelector('.pcad-field__message--error')?.textContent?.slice(0, 1024) ?? null,
      };
      return { ...result, observationMs: performance.now() - started };
    };
    const record = (event: Event, stage: 'window-capture' | 'canvas-capture'): void => {
      if (!(event instanceof PointerEvent)) return;
      if (records.length >= 24) { droppedEvents += 1; return; }
      records.push({
        stage, type: event.type, eventTimeStamp: event.timeStamp, actualMonotonicMs: performance.now(),
        clientX: event.clientX, clientY: event.clientY, button: event.button, buttons: event.buttons,
        pointerId: event.pointerId, pointerType: event.pointerType, isTrusted: event.isTrusted,
        altKey: event.altKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
        target: describe(event.target), targetIsCanvas: event.target === canvas,
        defaultPreventedAtCapture: event.defaultPrevented,
        // Only the outer capture samples owner state. The canvas capture proves arrival, not handler completion.
        state: stage === 'window-capture' ? snapshot() : null,
      });
    };
    const windowCapture = (event: Event): void => { record(event, 'window-capture'); };
    const canvasCapture = (event: Event): void => { record(event, 'canvas-capture'); };
    const types = ['pointermove', 'pointerdown', 'pointerup'] as const;
    const options = { capture: true, passive: true };
    for (const type of types) {
      window.addEventListener(type, windowCapture, options);
      canvas?.addEventListener(type, canvasCapture, options);
    }
    return {
      read: () => ({ records, droppedEvents, final: snapshot(),
        limits: 'DOM selection is an observation, not the draft. Store-owner checks do not expose the scene owner or ray hit. Capture precedes application handling; pointerup is a later event. Observer work can perturb timing.' }),
      dispose: () => {
        for (const type of types) {
          window.removeEventListener(type, windowCapture, options);
          canvas?.removeEventListener(type, canvasCapture, options);
        }
      },
    };
  });
  let actionFailed = false;
  let actionError: unknown;
  try { await select(); }
  catch (error) { actionFailed = true; actionError = error; }
  let diagnostic: string;
  try { diagnostic = await observation.evaluate(observed => JSON.stringify(observed.read())); }
  catch (error) { diagnostic = JSON.stringify({ observationError: String(error) }); }
  finally {
    // Cleanup failure must not replace the original assertion or input error.
    await observation.evaluate(observed => { observed.dispose(); }).catch(error => { console.warn('Hole-wall observer cleanup:', error); });
    await observation.dispose().catch(error => { console.warn('Hole-wall observer handle cleanup:', error); });
  }
  try {
    const diagnosticPath = info.outputPath('hole-wall-real-input.json');
    await writeFile(diagnosticPath, diagnostic, { encoding: 'utf8', flag: 'wx' });
    await info.attach('hole-wall-real-input.json', { path: diagnosticPath, contentType: 'application/json' });
  } catch (error) { console.warn('Hole-wall observation attachment:', error); }
  if (actionFailed) {
    const summary = diagnostic.length <= 16000 ? diagnostic : diagnostic.slice(0, 16000) + ' [message truncated; full JSON attached]';
    throw new Error(String(actionError) + String.fromCharCode(10) + 'Hole-wall input observation: ' + summary, { cause: actionError });
  }
}
export async function createHoleWallMateScenario(page: Page, info: TestInfo,
  app?: ElectronApplication, legacyConfirmation = false, independentSavedParts = false): Promise<SavedHoleWallMateScenario> {
  if (legacyConfirmation && independentSavedParts) throw new Error('Legacy shared-source and independent-source fixtures are distinct');
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await waitForSettledRecompute(page);
  await buildCurrentHoleWallPart(page);
  const inputPartPath = info.outputPath('actual-hole-wall-part.pcad');
  let inputPart = savedDocument(await saveUiPart(page, inputPartPath, app));
  if (legacyConfirmation) {
    // A real UI-built part becomes a historical-ID fixture before any Assembly embedding.
    const original = new Uint8Array(await readFile(inputPartPath));
    const archive = readArchive(original, { shouldExtract: () => true });
    if (!archive.ok) throw new Error('Actual legacy source ZIP unreadable');
    const entries: PcadZipEntries = new Map();
    for (const [name, bytes] of archive.entries) {
      let next = bytes;
      if (name === PCAD_DOCUMENT_ENTRY) {
        const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope))
          throw new Error('Invalid actual source envelope');
        const document: unknown = Reflect.get(envelope, 'document');
        if (document === null || typeof document !== 'object' || Array.isArray(document))
          throw new Error('Invalid actual source document');
        next = new TextEncoder().encode(JSON.stringify({ ...envelope,
          document: { ...document, id: 'part-1' } }, null, 2) + '\n');
      }
      entries.set(name, [next, { level: 6, mtime: FIXED_ENTRY_MTIME }]);
    }
    const legacyBytes = zipPcadEntries(entries);
    const legacyDocument = savedDocument(legacyBytes);
    expect(legacyDocument).toEqual({ ...inputPart, id: 'part-1' });
    const legacyArchive = readArchive(legacyBytes, { shouldExtract: () => true });
    if (!legacyArchive.ok) throw new Error('Legacy codec ZIP unreadable');
    expect([...legacyArchive.entries.keys()].sort()).toEqual([...archive.entries.keys()].sort());
    for (const [name, bytes] of archive.entries) {
      if (name !== PCAD_DOCUMENT_ENTRY) assertExactBinary(legacyArchive.entries.get(name), bytes, name);
      if (name !== PCAD_DOCUMENT_ENTRY) expect(legacyArchive.entries.get(name)).toEqual(bytes);
    }
    await writeFile(inputPartPath, legacyBytes);
    await openActualR18File(page, inputPartPath, app);
    const reopened = await saveUiPart(page, inputPartPath, app);
    inputPart = savedDocument(reopened);
    expect(inputPart).toEqual(legacyDocument);
    const reopenedArchive = readArchive(reopened, { shouldExtract: () => true });
    if (!reopenedArchive.ok) throw new Error('Real opened legacy ZIP unreadable');
    expect([...reopenedArchive.entries.keys()].sort()).toEqual([...legacyArchive.entries.keys()].sort());
    for (const [name, bytes] of legacyArchive.entries) {
      if (name !== PCAD_DOCUMENT_ENTRY && name !== 'thumbnail.png') {
        assertExactBinary(reopenedArchive.entries.get(name), bytes, name);
        expect(reopenedArchive.entries.get(name)).toEqual(bytes);
      }
    }
    await info.attach('legacy-source-open-save', { body: await page.screenshot(), contentType: 'image/png' });
  }
  const hole = inputPart.solids.find(solid => solid.kind === 'hole');
  if (hole?.kind !== 'hole') throw new Error('Actual saved part has no hole');

  const partBytes = new Uint8Array(await readFile(inputPartPath));
  const independentParts: SavedHoleWallPart[] = [];
  let secondBytes: Uint8Array = partBytes;
  if (independentSavedParts) {
    await fileAction(page, '新規').click();
    await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
    await waitForSettledRecompute(page);
    await buildCurrentHoleWallPart(page);
    const secondPath = info.outputPath('actual-hole-wall-part-b.pcad');
    secondBytes = await saveUiPart(page, secondPath, app);
    const secondDocument = savedDocument(secondBytes);
    const secondHole = secondDocument.solids.find(feature => feature.kind === 'hole');
    if (secondHole?.kind !== 'hole') throw new Error('Second actual saved Part has no hole');
    expect(secondPath).not.toBe(inputPartPath);
    expect(secondDocument.id).not.toBe(inputPart.id);
    assertExactBinary(new Uint8Array(await readFile(secondPath)), secondBytes, 'separately saved Part B');
    assertExactBinary(new Uint8Array(await readFile(inputPartPath)), partBytes, 'separately saved Part A');
    for (const source of [
      { path: inputPartPath, fileName: 'actual-hole-wall-part.pcad', document: inputPart, holeId: hole.id, bytes: partBytes },
      { path: secondPath, fileName: 'actual-hole-wall-part-b.pcad', document: secondDocument, holeId: secondHole.id, bytes: secondBytes },
    ]) independentParts.push({ path: source.path, fileName: source.fileName, document: source.document, holeId: source.holeId,
      rawSha256: createHash('sha256').update(source.bytes).digest('hex'),
      contentHash: createHash('sha256').update(canonicalPartDocumentText(source.document), 'utf8').digest('hex') });
    expect(independentParts[0]?.rawSha256).not.toBe(independentParts[1]?.rawSha256);
    expect(independentParts[0]?.contentHash).not.toBe(independentParts[1]?.contentHash);
  }
  await startNewAssemblyCapture(page);
  await installAssemblyFileGateway(page, { parts: [
    { fileName: 'actual-hole-wall-part.pcad', bytes: partBytes },
    { fileName: independentSavedParts ? 'actual-hole-wall-part-b.pcad' : 'actual-hole-wall-part.pcad', bytes: secondBytes },
  ] });
  try {
    await placeQueuedPartCapture(page, ['0', '0', '0']);
    await placeQueuedPartCapture(page, ['60', '0', '0']);
  } finally {
    // The queued gateway's save callback is synthetic: never use it for the saved PCADA.
    await resetAssemblyFileGateway(page);
  }
  const before = await wallMateStats(page);
  expect(before.mateIds).toEqual([]);
  expect(before.components[0]?.resolved?.position).toEqual([0, 0, 0]);
  expect(before.components[1]?.resolved?.position).toEqual([60, 0, 0]);
  await chooseToolMenuItem(page, '合わせる', '同心');
  const dialog = page.getByRole('dialog', { name: '合致を作る', exact: true });
  await expect(dialog).toBeVisible();
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  const inset = 3 * Math.SQRT1_2;
  await withHoleWallInputObservation(page, info, async () => {
    await clickWorldPoint(page, [20 - inset, 15 + inset, 9]);
    await expect(dialog.locator('li')).toHaveCount(1);
    await clickWorldPoint(page, [80 - inset, 15 + inset, 9]);
    await expect(dialog.locator('li')).toHaveCount(2);
  });
  for (const item of await dialog.locator('li').all()) await expect(item).toContainText('面');
  const commit = dialog.getByRole('button', { name: '合致を作る', exact: true });
  await expect(commit).toHaveAttribute('aria-disabled', 'false');
  const mateToken = await beginRecompute(page);
  await commit.click();
  await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, mateToken);
  await waitForSettledRecompute(page);
  const solved = await wallMateStats(page);
  expect(solved.mateIds).toHaveLength(1);
  expect(solved.components[0]).toEqual(before.components[0]);
  expect(solved.components[1]?.resolved).not.toEqual(before.components[1]?.resolved);
  expect(solved.diagnosis?.converged).toBe(true);
  expect(solved.diagnosis?.unresolvedMateIds).toEqual([]);
  await info.attach('hole-wall-mate-live', { body: await page.screenshot(), contentType: 'image/png' });
  const path = info.outputPath('actual-hole-wall-mate.pcada');
  const saveStarted = Date.now();
  const rawBytes = await saveUiPart(page, path, app);
  const saveFinished = Date.now();
  const bundle = await readWallMateBundle(rawBytes);
  for (const component of bundle.document.components) {
    if (component.source.kind !== 'part') throw new Error('Actual component is not an embedded part');
    const partRef = component.source.partRef;
    if (independentSavedParts) {
      const index = bundle.document.components.indexOf(component);
      const source = independentParts[index];
      if (source === undefined) throw new Error('Independent component source missing');
      expect(bundle.parts.get(component.source.partRef)).toEqual(source.document);
      const provenance = bundle.partFiles.find(entry => entry.ref === partRef);
      if (provenance === undefined) throw new Error('Actual embedded source provenance missing');
      expect(provenance.fileName).toBe(source.fileName);
      expect(provenance.contentHash).toBe(source.contentHash);
      expect(createHash('sha256').update(await readFile(source.path)).digest('hex')).toBe(source.rawSha256);
    } else {
      expect(bundle.parts.get(component.source.partRef)).toEqual(inputPart);
    }
  }
  const savedMate = bundle.document.mates[0];
  if (savedMate === undefined) throw new Error('Saved mate missing');
  for (const target of [savedMate.a, savedMate.b]) {
    if (target.kind !== 'subShape') throw new Error('Missing saved hole target');
    if (independentSavedParts) {
      const index = bundle.document.components.findIndex(component => component.id === target.componentId);
      const source = independentParts[index];
      if (source === undefined) throw new Error('Selected wall has no independent saved source');
      expect(target.ref.bodyFeatureId).toBe(source.holeId);
      expect(target.ref.origin?.identity.featureId).toBe(source.holeId);
    } else {
      expect(target.ref.bodyFeatureId).toBe(hole.id);
    }
  }
  if (independentSavedParts) {
    expect(bundle.parts.size).toBe(2);
    expect(bundle.partFiles).toHaveLength(2);
    const refs = bundle.document.components.map(component => component.source.kind === 'part' ? component.source.partRef : null);
    expect(refs[0]).not.toBe(refs[1]);
    await info.attach('independent-hole-part-source-proofs', { body: Buffer.from(JSON.stringify(independentParts.map(source =>
      ({ path: source.path, fileName: source.fileName, documentId: source.document.id, holeId: source.holeId,
        rawSha256: source.rawSha256, contentHash: source.contentHash })), null, 2)), contentType: 'application/json' });
  }
  return { path, inputPartPath, inputPart, holeId: hole.id, bundle, rawBytes,
    ...(independentSavedParts ? { independentParts } : {}),
    saveWindow: [saveStarted, saveFinished], before, solved };
}

/** Real native recompute of saved embedded parts; strict semantic lookup and analytic axes. */
export async function inspectFreshNativeHoleWallMate(scenario: SavedHoleWallMateScenario,
  stats: AssemblyBrowserStats = scenario.solved): Promise<void> {
  const api = createKernelApi(loadOcctForNode);
  const partId = `r18-wallmate-native-${scenario.holeId}`;
  const bridge = createDirectKernelBridge(api);
  try {
    const axes: { point: Vec3; direction: Vec3 }[] = [];
    const mate = scenario.bundle.document.mates[0];
    if (mate === undefined) throw new Error('Missing saved mate');
    for (const target of [mate.a, mate.b]) {
      if (target.kind !== 'subShape') throw new Error('Expected a real selected wall');
      const component = scenario.bundle.document.components.find(item => item.id === target.componentId);
      if (component?.source.kind !== 'part') throw new Error('Missing component part');
      const document = scenario.bundle.parts.get(component.source.partRef);
      if (document === undefined) throw new Error('Missing embedded saved part');
      const resolved = resolvePart(document);
      expect(resolved.errors).toEqual([]);
      const outcome = await bridge.recomputeSolids(resolved.steps, { partId, generation: axes.length + 1 });
      expect(outcome.failures).toEqual([]);
      expect(outcome.cancelled).toBe(false);
      const body = outcome.bodies.find(item => item.featureId === target.ref.bodyFeatureId);
      if (body === undefined) throw new Error('Missing actual current hole body');
      expect(body.volume).toBeCloseTo(12000 - 90 * Math.PI, 5);
      const match = resolveSubShapeReference(body, target.ref);
      expect(match.status).toBe('matched');
      if (match.status !== 'matched') throw new Error('Saved wall cannot be uniquely resolved');
      const geometry = match.match.geometry;
      if (geometry.kind !== 'face' || geometry.surfaceKind !== 'cylinder'
        || geometry.axis === null || geometry.axisOrigin === undefined) throw new Error('Native cylindrical axis unavailable');
      expect(geometry.radius).toBeCloseTo(3, 5);
      const actual = stats.components.find(item => item.id === target.componentId)?.resolved;
      if (actual === null || actual === undefined || actual.position.length !== 3 || actual.rotation.length !== 4)
        throw new Error('Actual solved placement unavailable');
      const [px, py, pz] = actual.position;
      const [qx, qy, qz, qw] = actual.rotation;
      if (px === undefined || py === undefined || pz === undefined || qx === undefined
        || qy === undefined || qz === undefined || qw === undefined) throw new Error('Incomplete solved pose');
      const position: Vec3 = [px, py, pz];
      const rotation: Quaternion = [qx, qy, qz, qw];
      axes.push({ point: applyPlacementToPoint({ position, rotation }, geometry.axisOrigin),
        direction: applyPlacementToDirection({ position, rotation }, geometry.axis) });
    }
    const [a, b] = axes;
    if (a === undefined || b === undefined) throw new Error('Two native axes required');
    const cross = (x: Vec3, y: Vec3): Vec3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const offset: Vec3 = [b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]];
    expect(Math.hypot(...cross(a.direction, b.direction))).toBeLessThanOrEqual(1e-9);
    expect(Math.hypot(...cross(offset, a.direction)) / Math.hypot(...a.direction)).toBeLessThanOrEqual(1e-9);
    // Concentric leaves translation along and rotation about the axis free.
  } finally {
    try { await api.releasePart(partId); } finally { bridge.dispose(); }
  }
}

/** Each Save captures the current rendered scene; validate and preserve both actual PNGs. */
async function assertDerivedThumbnailPair(page: Page, info: TestInfo,
  input: Uint8Array, output: Uint8Array, label: string): Promise<void> {
  for (const [side, raw] of [['before', input], ['after', output]] as const) {
    const archive = readArchive(raw, { shouldExtract: () => true });
    if (!archive.ok) throw new Error('Actual thumbnail archive unreadable');
    const png = archive.entries.get('thumbnail.png');
    if (png === undefined) throw new Error('Actual saved thumbnail missing');
    expect(png.byteLength).toBeGreaterThan(0);
    expect(png.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    const decoded = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      if (image.naturalWidth !== 256 || image.naturalHeight !== 256) {
        throw new Error('Actual saved thumbnail dimensions must be 256x256');
      }
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Actual thumbnail RGBA context unavailable');
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, 256, 256).data;
      const hasVisiblePixel = rgba.some((value, index) => index % 4 === 3 && value > 0);
      return { width: image.naturalWidth, height: image.naturalHeight, hasVisiblePixel };
    }, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 256, height: 256 });
    expect(decoded.hasVisiblePixel).toBe(true);
    await info.attach(`${label}-${side}-thumbnail`, { body: Buffer.from(png), contentType: 'image/png' });
    await info.attach(`${label}-${side}-thumbnail-sha256`, {
      body: Buffer.from(createHash('sha256').update(png).digest('hex')), contentType: 'text/plain' });
  }
}

/** Preserve every entry; fresh-render PNG mode requires separate real-browser decode evidence. */
function assertWallMateArchiveEqual(input: Uint8Array, output: Uint8Array,
  inputWindow: readonly [number, number], outputWindow: readonly [number, number],
  thumbnailMode: 'exact' | 'fresh-render' = 'exact'): void {
  const a = readArchive(input, { shouldExtract: () => true });
  const b = readArchive(output, { shouldExtract: () => true });
  if (!a.ok || !b.ok) throw new Error('Actual PCADA ZIP cannot be read');
  expect([...b.entries.keys()].sort()).toEqual([...a.entries.keys()].sort());
  for (const [name, bytes] of a.entries) {
    const next = b.entries.get(name);
    if (next === undefined) throw new Error('Archive entry lost');
    if (name === PCAD_DOCUMENT_ENTRY || /^parts\/[^/]+\.json$/u.test(name)) {
      const before: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const after: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(next));
      const envelope = (value: unknown, window: readonly [number, number]) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid envelope');
        const savedAt: unknown = Reflect.get(value, 'savedAt');
        if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt))) throw new Error('Missing actual save timestamp');
        expect(new Date(savedAt).toISOString()).toBe(savedAt);
        expect(Date.parse(savedAt)).toBeGreaterThanOrEqual(window[0]);
        expect(Date.parse(savedAt)).toBeLessThanOrEqual(window[1]);
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'savedAt'));
      };
      expect(envelope(after, outputWindow)).toEqual(envelope(before, inputWindow));
    } else if (name === 'thumbnail.png' && thumbnailMode === 'fresh-render') {
      // Both actual PNGs are separately decoded and attached by assertDerivedThumbnailPair.
      expect(next.byteLength).toBeGreaterThan(0);
    } else {
      assertExactBinary(next, bytes, name);
      expect(next).toEqual(bytes);
    }
  }
}

export async function reopenHoleWallMateScenario(page: Page, info: TestInfo,
  scenario: SavedHoleWallMateScenario, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  assertExactBinary(new Uint8Array(await readFile(scenario.path)), scenario.rawBytes, 'saved archive');
  expect(new Uint8Array(await readFile(scenario.path))).toEqual(scenario.rawBytes);
  if (app !== undefined) await openTarget(app, scenario.path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== undefined) await (await chooser).setFiles(scenario.path);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  const stats = await wallMateStats(page);
  expect(stats.mateIds).toEqual(scenario.solved.mateIds);
  expect(stats.components).toEqual(scenario.solved.components);
  expect(stats.components[0]).toEqual(scenario.before.components[0]);
  expect(stats.diagnosis?.converged).toBe(true);
  expect(stats.diagnosis?.unresolvedMateIds).toEqual([]);
  await inspectFreshNativeHoleWallMate(scenario, stats);
  await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
  await info.attach('hole-wall-mate-cold', { body: await page.screenshot(), contentType: 'image/png' });
  const saveStarted = Date.now();
  const output = await saveUiPart(page, info.outputPath('actual-hole-wall-mate-reopened.pcada'), app);
  const saveFinished = Date.now();
  const bundle = await readWallMateBundle(output);
  expect(bundle.document).toEqual(scenario.bundle.document);
  expect(bundle.parts).toEqual(scenario.bundle.parts);
  expect(bundle.assemblies).toEqual(scenario.bundle.assemblies);
  expect(bundle.partFiles).toEqual(scenario.bundle.partFiles);
  assertAttachmentBinary(bundle.partAttachments, scenario.bundle.partAttachments);
  expect(bundle.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(bundle.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  await assertDerivedThumbnailPair(page, info, scenario.rawBytes, output, 'cold-resave');
  assertWallMateArchiveEqual(scenario.rawBytes, output, scenario.saveWindow, [saveStarted, saveFinished], 'fresh-render');
}

/** Real native recompute of saved embedded parts; strict semantic lookup and analytic axes. */
export async function inspectFreshNativeHoleWallMatePhi8(scenario: SavedHoleWallMateScenario,
  stats: AssemblyBrowserStats = scenario.solved): Promise<void> {
  const api = createKernelApi(loadOcctForNode);
  const partId = `r18-wallmate-native-${scenario.holeId}`;
  const bridge = createDirectKernelBridge(api);
  try {
    const axes: { point: Vec3; direction: Vec3 }[] = [];
    const mate = scenario.bundle.document.mates[0];
    if (mate === undefined) throw new Error('Missing saved mate');
    for (const target of [mate.a, mate.b]) {
      if (target.kind !== 'subShape') throw new Error('Expected a real selected wall');
      const component = scenario.bundle.document.components.find(item => item.id === target.componentId);
      if (component?.source.kind !== 'part') throw new Error('Missing component part');
      const document = scenario.bundle.parts.get(component.source.partRef);
      if (document === undefined) throw new Error('Missing embedded saved part');
      const resolved = resolvePart(document);
      expect(resolved.errors).toEqual([]);
      const outcome = await bridge.recomputeSolids(resolved.steps, { partId, generation: axes.length + 1 });
      expect(outcome.failures).toEqual([]);
      expect(outcome.cancelled).toBe(false);
      const body = outcome.bodies.find(item => item.featureId === target.ref.bodyFeatureId);
      if (body === undefined) throw new Error('Missing actual current hole body');
      expect(body.volume).toBeCloseTo(12000 - 160 * Math.PI, 5);
      const match = resolveSubShapeReference(body, target.ref);
      expect(match.status).toBe('matched');
      if (match.status !== 'matched') throw new Error('Saved wall cannot be uniquely resolved');
      const geometry = match.match.geometry;
      if (geometry.kind !== 'face' || geometry.surfaceKind !== 'cylinder'
        || geometry.axis === null || geometry.axisOrigin === undefined) throw new Error('Native cylindrical axis unavailable');
      expect(geometry.radius).toBeCloseTo(4, 5);
      expect(match.match.reference.origin).toEqual(target.ref.origin);
      if (body.origins?.state !== 'tracked' || target.ref.origin === undefined)
        throw new Error('Actual current hole/rim origin proof unavailable');
      const savedOrigin = target.ref.origin;
      if (savedOrigin.shapeKind !== 'face') throw new Error('Saved wall identity must be a face');
      const rims = body.origins.bindings.filter(binding => binding.state === 'unique'
        && binding.origin.shapeKind === 'edge' && binding.origin.identity.kind === 'face-intersection-edge'
        && binding.origin.identity.faces.some(face => isDeepStrictEqual(face, savedOrigin.identity)));
      expect(rims).toHaveLength(2);
      for (const rim of rims) {
        if (rim.state !== 'unique' || rim.current.kind !== 'edge') throw new Error('Actual current rim not unique');
        const index = rim.current.index;
        const edge = body.edges.find(item => item.index === index);
        expect(edge?.curveKind).toBe('circle');
        expect(edge?.radius).toBeCloseTo(4, 5);
      }
      const actual = stats.components.find(item => item.id === target.componentId)?.resolved;
      if (actual === null || actual === undefined || actual.position.length !== 3 || actual.rotation.length !== 4)
        throw new Error('Actual solved placement unavailable');
      const [px, py, pz] = actual.position;
      const [qx, qy, qz, qw] = actual.rotation;
      if (px === undefined || py === undefined || pz === undefined || qx === undefined
        || qy === undefined || qz === undefined || qw === undefined) throw new Error('Incomplete solved pose');
      const position: Vec3 = [px, py, pz];
      const rotation: Quaternion = [qx, qy, qz, qw];
      axes.push({ point: applyPlacementToPoint({ position, rotation }, geometry.axisOrigin),
        direction: applyPlacementToDirection({ position, rotation }, geometry.axis) });
    }
    const [a, b] = axes;
    if (a === undefined || b === undefined) throw new Error('Two native axes required');
    const cross = (x: Vec3, y: Vec3): Vec3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const offset: Vec3 = [b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]];
    expect(Math.hypot(...cross(a.direction, b.direction))).toBeLessThanOrEqual(1e-9);
    expect(Math.hypot(...cross(offset, a.direction)) / Math.hypot(...a.direction)).toBeLessThanOrEqual(1e-9);
    // Concentric leaves translation along and rotation about the axis free.
  } finally {
    try { await api.releasePart(partId); } finally { bridge.dispose(); }
  }
}




async function openActualR18File(page: Page, path: string, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
}


async function assertNativeConfirmationClosed(page: Page): Promise<void> {
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    return active !== null && active.isConnected && active.closest('dialog') === null;
  })).toBe(true);
}

/** Real native dialog under the app's StrictMode; no store/request/geometry injection. */
async function exerciseLegacyConfirmationCancellation(page: Page, info: TestInfo,
  scenario: SavedHoleWallMateScenario, updatedPartBytes: Uint8Array, selectedFileName: string, app?: ElectronApplication): Promise<void> {
  expect(scenario.inputPart.id).toBe('part-1');
  const confirmation = page.getByRole('alertdialog', { name: '同じ元部品か確認', exact: true });
  const show = async (): Promise<void> => {
    await installAssemblyFileGateway(page, { parts: [{ fileName: selectedFileName, bytes: updatedPartBytes }] });
    const section = page.locator('.pcad-tree__sections > li').filter({
      has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }),
    });
    await section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__more').first().click();
    const action = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '元の部品を取り込み直す', exact: true });
    await expect(action).toHaveAttribute('aria-disabled', 'false');
    await action.click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(scenario.inputPart.name);
    await expect(confirmation).toContainText(selectedFileName);
    await expect(confirmation.getByText(`選択ファイル: ${selectedFileName}`, { exact: true })).toBeVisible();
    const cancel = confirmation.getByRole('button', { name: '戻る', exact: true });
    await expect(cancel).toBeFocused();
    expect(await cancel.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await confirmation.evaluate(element => element instanceof HTMLDialogElement && element.open)).toBe(true);
  };
  // Real reopened-session baseline, before either confirmation request. Save does not add Undo.
  // Read existing observation hooks only; never inject or change application state.
  const recordOwnership = async (stage: string): Promise<void> => {
    const observation = await page.evaluate(() => {
      const readings: Record<string, unknown> = {};
      for (const name of ['pcadRecomputeStats', 'pcadAssemblyStats', 'pcadViewportRenderStats',
        'pcadViewportMemoryStats', 'pcadViewportMeshObservation', 'pcadViewportRetiredCleanups',
        'pcadViewportAssemblyOwner', 'pcadMeshLedgerDiagnostics']) {
        const reader: unknown = Reflect.get(window, name);
        if (typeof reader !== 'function') readings[name] = { available: false };
        else {
          try { readings[name] = { available: true, value: Reflect.apply(reader, window, []) }; }
          catch (error) { readings[name] = { available: true, error: String(error) }; }
        }
      }
      return { actualEpochMs: Date.now(), actualMonotonicMs: performance.now(), readings,
        documentKind: document.querySelector('.pcad-shell')?.getAttribute('data-document-kind') ?? null,
        ownerFieldObservationHook: 'pcadViewportAssemblyOwner',
        ownerFieldsUnavailableWithoutHook: ['activeDocumentId', 'documentVersion', 'cancelRequestCount',
          'recomputeCancelled', 'assemblyLibraryIdentity', 'assemblyViewIdentity',
          'meshOwnershipReceiptCurrent', 'meshOwnershipBackingInspectionCurrent'] };
    });
    await info.attach(`legacy-owner-${stage}.json`, {
      body: Buffer.from(JSON.stringify(observation, null, 2)), contentType: 'application/json',
    });
    await info.attach(`legacy-owner-${stage}-canvas.png`, {
      body: await page.locator('canvas.pcad-viewport__canvas').screenshot(), contentType: 'image/png',
    });
  };

  const completedViewportRenders = (): Promise<number> => page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadViewportRenderStats');
    if (typeof read !== 'function') throw new Error('Actual viewport render observation unavailable');
    const stats: unknown = Reflect.apply(read, window, []);
    if (stats === null || typeof stats !== 'object') throw new Error('Actual viewport render observation invalid');
    const count: unknown = Reflect.get(stats, 'completedRenders');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new Error('Actual completed viewport render counter invalid');
    return count;
  });
  const settleSaveInput = async (): Promise<void> => {
    const beforeRender = await completedViewportRenders();
    await page.locator('canvas.pcad-viewport__canvas').click({ position: { x: 4, y: 4 } });
    await page.mouse.move(0, 0);
    await waitForSettledRecompute(page);
    expect(await wallMateStats(page)).toEqual(scenario.solved);
    // A settled calculation is not a completed view frame. Observe the real renderer, without triggering a synthetic redraw.
    await expect.poll(completedViewportRenders).toBeGreaterThan(beforeRender);
  };
  await resetAssemblyFileGateway(page);
  await settleSaveInput();
  await recordOwnership('baseline-before-save');
  const baselineStarted = Date.now();
  const baselineRaw = await saveUiPart(page, info.outputPath('legacy-confirm-session-baseline.pcada'), app);
  const baselineFinished = Date.now();
  const captureReasons = await page.evaluate(() => {
    const reader: unknown = Reflect.get(window, 'pcadThumbnailCaptureReasons');
    if (typeof reader !== 'function') return { available: false };
    try { return { available: true, value: Reflect.apply(reader, window, []) }; }
    catch (error) { return { available: true, error: String(error) }; }
  });
  const captureReasonBytes = Buffer.from(JSON.stringify(captureReasons, null, 2));
  await writeFile(info.outputPath('legacy-thumbnail-baseline-after-save.json'), captureReasonBytes);
  await info.attach('legacy-thumbnail-baseline-after-save.json', {
    body: captureReasonBytes, contentType: 'application/json',
  });
  const baselineBundle = await readWallMateBundle(baselineRaw);
  expect(baselineBundle.document).toEqual(scenario.bundle.document);
  expect(baselineBundle.parts).toEqual(scenario.bundle.parts);
  expect(baselineBundle.assemblies).toEqual(scenario.bundle.assemblies);
  expect(baselineBundle.partFiles).toEqual(scenario.bundle.partFiles);
  assertAttachmentBinary(baselineBundle.partAttachments, scenario.bundle.partAttachments);
  expect(baselineBundle.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(baselineBundle.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  await assertDerivedThumbnailPair(page, info, scenario.rawBytes, baselineRaw, 'reopened-baseline');
  assertWallMateArchiveEqual(scenario.rawBytes, baselineRaw, scenario.saveWindow,
    [baselineStarted, baselineFinished], 'fresh-render');
  const unchanged = async (label: string): Promise<void> => {
    await resetAssemblyFileGateway(page);
    await waitForSettledRecompute(page);
    expect(await wallMateStats(page)).toEqual(scenario.solved);
    await recordOwnership(`${label}-before-undo`);
    // Reopening the saved assembly started with no Undo; cancellation must not add an entry.
    await page.locator('canvas.pcad-viewport__canvas').focus();
    await page.keyboard.press('Control+z');
    await waitForSettledRecompute(page);
    expect(await wallMateStats(page)).toEqual(scenario.solved);
    await recordOwnership(`${label}-after-undo-before-settle`);
    await settleSaveInput();
    const started = Date.now();
    await recordOwnership(`${label}-before-save`);
    const raw = await saveUiPart(page, info.outputPath(`legacy-confirm-${label}-unchanged.pcada`), app);
    const finished = Date.now();
    const bundle = await readWallMateBundle(raw);
    expect(bundle.document).toEqual(scenario.bundle.document);
    expect(bundle.parts).toEqual(scenario.bundle.parts);
    expect(bundle.assemblies).toEqual(scenario.bundle.assemblies);
    expect(bundle.partFiles).toEqual(scenario.bundle.partFiles);
    assertAttachmentBinary(bundle.partAttachments, scenario.bundle.partAttachments);
    expect(bundle.partAttachments).toEqual(scenario.bundle.partAttachments);
    expect(bundle.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
    assertWallMateArchiveEqual(baselineRaw, raw, [baselineStarted, baselineFinished], [started, finished]);
  };
  try {
    await show();
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await assertNativeConfirmationClosed(page);
    await recordOwnership('escape-dialog-closed');
    await unchanged('escape');
    // A real fresh request must survive the previous dialog's deferred cleanup.
    await show();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: '戻る', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await assertNativeConfirmationClosed(page);
    await recordOwnership('cancel-dialog-closed');
    await unchanged('cancel');
  } finally { await resetAssemblyFileGateway(page); }
}

/** Real expression edit and explicit same-source refresh; saved targets are never selected again. */
export async function updateHoleWallMatePhi8Scenario(page: Page, info: TestInfo,
  scenario: SavedHoleWallMateScenario, app?: ElectronApplication, confirmationAcceptance = false): Promise<SavedHoleWallMateScenario> {
  const originalPartBytes = new Uint8Array(await readFile(scenario.inputPartPath));
  const partRef = scenario.bundle.document.components[0]?.source;
  if (partRef?.kind !== 'part') throw new Error('Missing shared source');
  for (const component of scenario.bundle.document.components) {
    expect(component.source).toEqual(partRef);
  }
  expect(scenario.bundle.parts.size).toBe(1);
  await openActualR18File(page, scenario.inputPartPath, app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
  await treeRow(page, '穴1').click();
  const diameterBox = propertyPanel(page).locator('.pcad-field').filter({
    has: page.locator('.pcad-field__label', { hasText: /^直径$/u }),
  });
  const diameter = diameterBox.locator('input.pcad-field__input');
  await expect(diameter).toHaveValue('6');
  const editToken = await beginRecompute(page);
  await diameter.fill('2*4');
  await treeRow(page, '押し出し1').click();
  await waitForRecompute(page, editToken);
  await waitForSettledRecompute(page);
  await treeRow(page, '穴1').click();
  await expect(diameter).toHaveValue('2*4');
  await expect.poll(async () => Math.abs(Number((await volumeText(page).innerText()).replaceAll(',', '')
    .match(/[\d.]+/u)?.[0]) - (12000 - 160 * Math.PI)), { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
  const selectedFileName = confirmationAcceptance ? 'actual-$&-hole-wall-part-phi8.pcad' : 'actual-hole-wall-part-phi8.pcad';
  const updatedPartPath = info.outputPath(selectedFileName);
  const updatedPartBytes = await saveUiPart(page, updatedPartPath, app);
  const updatedPart = savedDocument(updatedPartBytes);
  const changedHole = updatedPart.solids.find(item => item.id === scenario.holeId);
  const originalHole = scenario.inputPart.solids.find(item => item.id === scenario.holeId);
  if (changedHole?.kind !== 'hole' || originalHole?.kind !== 'hole') throw new Error('Actual saved hole lost');
  expect(changedHole.diameter.source).toBe('2*4');
  expect(changedHole.diameter.value).toBe(8);
  expect(updatedPart).toEqual({ ...scenario.inputPart, solids: scenario.inputPart.solids.map(item =>
    item.id === scenario.holeId ? { ...originalHole, diameter: changedHole.diameter } : item) });
  const originalArchive = readArchive(originalPartBytes, { shouldExtract: () => true });
  const updatedArchive = readArchive(updatedPartBytes, { shouldExtract: () => true });
  if (!originalArchive.ok || !updatedArchive.ok) throw new Error('Actual source ZIP unreadable');
  expect([...updatedArchive.entries.keys()].sort()).toEqual([...originalArchive.entries.keys()].sort());
  for (const [name, bytes] of originalArchive.entries) {
    if (name !== PCAD_DOCUMENT_ENTRY && name !== 'thumbnail.png') assertExactBinary(updatedArchive.entries.get(name), bytes, name);
    if (name !== PCAD_DOCUMENT_ENTRY && name !== 'thumbnail.png') expect(updatedArchive.entries.get(name)).toEqual(bytes);
  }
  // The two edited documents were decoded above in full; the actual preview PNG is a new rendering.
  await info.attach('source-phi8-preview', { body: await page.screenshot(), contentType: 'image/png' });
  await openActualR18File(page, scenario.path, app);
  expect(await wallMateStats(page)).toEqual(scenario.solved);
  if (confirmationAcceptance) await exerciseLegacyConfirmationCancellation(page, info, scenario, updatedPartBytes, selectedFileName, app);
  await installAssemblyFileGateway(page, { parts: [{ fileName: selectedFileName, bytes: updatedPartBytes }] });
  const refreshStarted = Date.now();
  try {
    const section = page.locator('.pcad-tree__sections > li').filter({
      has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }),
    });
    await section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__more').first().click();
    const action = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '元の部品を取り込み直す', exact: true });
    await expect(action).toHaveAttribute('aria-disabled', 'false');
    const refreshToken = await beginRecompute(page);
    await action.click();
    const confirmation = page.getByRole('alertdialog', { name: '同じ元部品か確認', exact: true });
    if (!/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(scenario.inputPart.id)) {
      // This is the actual legacy confirmation UI in SEM's separately reviewed identity candidate.
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText(scenario.inputPart.name);
      await expect(confirmation).toContainText(selectedFileName);
      await expect(confirmation.getByText(`選択ファイル: ${selectedFileName}`, { exact: true })).toBeVisible();
      if (confirmationAcceptance) {
        await expect(confirmation.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
        const approve = confirmation.getByRole('button', { name: '同じ元部品として更新する', exact: true });
        const bounds = await approve.boundingBox();
        if (bounds === null) throw new Error('Native confirmation approve has no real bounds');
        await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      } else {
        await confirmation.getByRole('button', { name: '同じ元部品として更新する', exact: true }).click();
      }
    }
    await expect(confirmation).toHaveCount(0);
    if (confirmationAcceptance) await assertNativeConfirmationClosed(page);
    await waitForRecompute(page, refreshToken);
    await waitForSettledRecompute(page);
  } finally {
    // Never use the placement/source picker gateway's synthetic save callback as saved-file evidence.
    await resetAssemblyFileGateway(page);
  }
  const refreshFinished = Date.now();
  const solved = await wallMateStats(page);
  expect(solved).toEqual(scenario.solved);
  expect(solved.diagnosis?.converged).toBe(true);
  expect(solved.diagnosis?.unresolvedMateIds).toEqual([]);
  const saveStarted = Date.now();
  const path = info.outputPath('actual-hole-wall-mate-phi8.pcada');
  const rawBytes = await saveUiPart(page, path, app);
  const saveFinished = Date.now();
  const bundle = await readWallMateBundle(rawBytes);
  expect(bundle.document).toEqual(scenario.bundle.document);
  expect(bundle.parts).toEqual(new Map([[partRef.partRef, updatedPart]]));
  expect(bundle.assemblies).toEqual(scenario.bundle.assemblies);
  assertAttachmentBinary(bundle.partAttachments, scenario.bundle.partAttachments);
  expect(bundle.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(bundle.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  expect(bundle.partFiles).toHaveLength(scenario.bundle.partFiles.length);
  for (const entry of bundle.partFiles) {
    const previous = scenario.bundle.partFiles.find(item => item.ref === entry.ref);
    if (previous === undefined) throw new Error('Unexpected new source provenance');
    expect(entry).toMatchObject({ ref: previous.ref, fileName: previous.fileName, path: previous.path });
    const previousDigest = scenario.bundle.partAttachmentDigests.get(previous.ref);
    if (previousDigest === undefined) throw new Error('Previous source attachment digest missing');
    expect(bundle.partAttachmentDigests.get(entry.ref)).toBe(previousDigest);
    expect(entry.contentHash).not.toBe(previous.contentHash);
    expect(new Date(entry.importedAt).toISOString()).toBe(entry.importedAt);
    expect(Date.parse(entry.importedAt)).toBeGreaterThanOrEqual(refreshStarted);
    expect(Date.parse(entry.importedAt)).toBeLessThanOrEqual(refreshFinished);
  }
  const updated: SavedHoleWallMateScenario = { ...scenario, path, rawBytes, bundle,
    inputPartPath: updatedPartPath, inputPart: updatedPart, solved, saveWindow: [saveStarted, saveFinished] };
  await inspectFreshNativeHoleWallMatePhi8(updated);
  // One actual Undo restores the shared library and every saved mate/joint/source record together.
  const undoToken = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, undoToken);
  await waitForSettledRecompute(page);
  expect(await wallMateStats(page)).toEqual(scenario.solved);
  // Calculation completion is distinct from the current rendered Assembly frame.
  const completedRenders = (): Promise<number> => page.evaluate(() => {
    const reader: unknown = Reflect.get(window, 'pcadViewportRenderStats');
    if (typeof reader !== 'function') throw new Error('Actual viewport render observation unavailable');
    const stats: unknown = Reflect.apply(reader, window, []);
    if (stats === null || typeof stats !== 'object') throw new Error('Actual viewport render observation invalid');
    const count: unknown = Reflect.get(stats, 'completedRenders');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new Error('Actual completed viewport render counter invalid');
    return count;
  });
  const beforeRender = await completedRenders();
  await page.locator('canvas.pcad-viewport__canvas').click({ position: { x: 4, y: 4 } });
  await page.mouse.move(0, 0);
  await waitForSettledRecompute(page);
  expect(await wallMateStats(page)).toEqual(scenario.solved);
  await expect.poll(completedRenders).toBeGreaterThan(beforeRender);
  const undoStarted = Date.now();
  const undoneBytes = await saveUiPart(page, info.outputPath('actual-hole-wall-mate-one-undo.pcada'), app);
  const undoFinished = Date.now();
  const undone = await readWallMateBundle(undoneBytes);
  expect(undone.document).toEqual(scenario.bundle.document);
  expect(undone.parts).toEqual(scenario.bundle.parts);
  expect(undone.assemblies).toEqual(scenario.bundle.assemblies);
  expect(undone.partFiles).toEqual(scenario.bundle.partFiles);
  assertAttachmentBinary(undone.partAttachments, scenario.bundle.partAttachments);
  expect(undone.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(undone.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  await assertDerivedThumbnailPair(page, info, scenario.rawBytes, undoneBytes, 'undo-resave');
  assertWallMateArchiveEqual(scenario.rawBytes, undoneBytes, scenario.saveWindow, [undoStarted, undoFinished], 'fresh-render');
  await inspectFreshNativeHoleWallMate({ ...scenario, bundle: undone, rawBytes: undoneBytes });
  // Restore the real saved updated file, not a synthetic document, for the following process-cold proof.
  await openActualR18File(page, updated.path, app);
  expect(await wallMateStats(page)).toEqual(solved);
  await inspectFreshNativeHoleWallMatePhi8(updated);
  return updated;
}

export async function reopenHoleWallMatePhi8Scenario(page: Page, info: TestInfo,
  scenario: SavedHoleWallMateScenario, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  assertExactBinary(new Uint8Array(await readFile(scenario.path)), scenario.rawBytes, 'saved archive');
  expect(new Uint8Array(await readFile(scenario.path))).toEqual(scenario.rawBytes);
  if (app !== undefined) await openTarget(app, scenario.path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== undefined) await (await chooser).setFiles(scenario.path);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  const stats = await wallMateStats(page);
  expect(stats.mateIds).toEqual(scenario.solved.mateIds);
  expect(stats.components).toEqual(scenario.solved.components);
  expect(stats.components[0]).toEqual(scenario.before.components[0]);
  expect(stats.diagnosis?.converged).toBe(true);
  expect(stats.diagnosis?.unresolvedMateIds).toEqual([]);
  await inspectFreshNativeHoleWallMatePhi8(scenario, stats);
  await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
  await info.attach('hole-wall-mate-phi8-cold', { body: await page.screenshot(), contentType: 'image/png' });
  const saveStarted = Date.now();
  const output = await saveUiPart(page, info.outputPath('actual-hole-wall-mate-phi8-reopened.pcada'), app);
  const saveFinished = Date.now();
  const bundle = await readWallMateBundle(output);
  expect(bundle.document).toEqual(scenario.bundle.document);
  expect(bundle.parts).toEqual(scenario.bundle.parts);
  expect(bundle.assemblies).toEqual(scenario.bundle.assemblies);
  expect(bundle.partFiles).toEqual(scenario.bundle.partFiles);
  assertAttachmentBinary(bundle.partAttachments, scenario.bundle.partAttachments);
  expect(bundle.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(bundle.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  await assertDerivedThumbnailPair(page, info, scenario.rawBytes, output, 'cold-resave');
  assertWallMateArchiveEqual(scenario.rawBytes, output, scenario.saveWindow, [saveStarted, saveFinished], 'fresh-render');
}
import { createShapeCache } from '../../packages/kernel/src/worker/shapeCache.js';
import { solidMeshBuffers, type CachedSolid } from '../../packages/kernel/src/worker/recomputeSolids.js';
import type { CurrentMeshOwner } from '../../packages/kernel/src/worker/kernelApi.js';

export type HoleRimOperation = 'R面取り' | 'C面取り';
export interface SavedHoleRimScenario {
  readonly path: string;
  readonly operation: HoleRimOperation;
  readonly document: PartDocument;
  readonly rawBytes: Uint8Array;
  readonly holeId: string;
  readonly roundId: string;
  readonly radius: 3 | 4;
}

/** Independent revolution integral: through hole plus a 1mm entry chamfer/round. */
function holeRimVolume(operation: HoleRimOperation, radius: number): number {
  return 12000 - 10 * Math.PI * radius * radius - (operation === 'C面取り'
    ? Math.PI * (radius + 1 / 3)
    : Math.PI * (2 * radius + 5 / 3 - Math.PI * (radius + 1) / 2));
}

function savedRim(document: PartDocument, operation: HoleRimOperation) {
  const hole = document.solids.find(item => item.kind === 'hole');
  const round = document.solids.find(item => item.name === `${operation}1`);
  if (hole?.kind !== 'hole' || round === undefined
    || (round.kind !== 'fillet' && round.kind !== 'chamfer')) throw new Error('Actual saved hole/rim missing');
  expect(round.kind).toBe(operation === 'R面取り' ? 'fillet' : 'chamfer');
  expect(round.targets).toHaveLength(1);
  const target = round.targets[0];
  if (target === undefined || target.origin?.identity.kind !== 'face-intersection-edge')
    throw new Error('Actual saved circular rim lacks a semantic face intersection');
  expect(target.bodyFeatureId).toBe(hole.id);
  expect(target.fingerprint).toMatchObject({ kind: 'edge', curveKind: 'circle', radius: 3 });
  const walls = target.origin.identity.faces.filter(face => face.kind === 'hole-face');
  expect(walls).toHaveLength(1);
  expect(walls[0]).toMatchObject({ kind: 'hole-face', featureId: hole.id, role: 'wall' });
  return { hole, round, target };
}

async function expectRimUiVolume(page: Page, operation: HoleRimOperation, radius: number): Promise<void> {
  await treeRow(page, `${operation}1`).click();
  await expect.poll(async () => Math.abs(Number.parseFloat((await volumeText(page).innerText()).replaceAll(',', ''))
    - holeRimVolume(operation, radius)), { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
}

export async function createHoleRimScenario(page: Page, info: TestInfo,
  operation: HoleRimOperation, app?: ElectronApplication): Promise<SavedHoleRimScenario> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await waitForSettledRecompute(page);
  await buildCurrentHoleWallPart(page);
  await sketchTool(page, '選択').click();
  await page.keyboard.press('2');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  await clickWorldPoint(page, [20 + 3 / Math.sqrt(2), 15 - 3 / Math.sqrt(2), 10]);
  await openToolMenu(page, '加工');
  const tool = toolMenuPanel(page, '加工').getByRole('button', { name: operation, exact: true });
  await expect(tool).toBeEnabled();
  await tool.click();
  await expect(popoverTitle(page)).toHaveText(operation === 'R面取り' ? '角を丸める' : '面を取る');
  await fillFields(page, ['1']);
  const token = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
  await expectRimUiVolume(page, operation, 3);
  const selectedEdges = propertyPanel(page).locator('dt.pcad-properties__key').filter({ hasText: /^選んだ辺$/u })
    .locator('xpath=following-sibling::dd[1]');
  await expect(selectedEdges).toHaveText('1');
  const path = info.outputPath(`actual-hole-rim-${operation}.pcad`);
  const rawBytes = await saveUiPart(page, path, app);
  expect(rawBytes.byteLength).toBeGreaterThan(100);
  const document = savedDocument(rawBytes);
  const { hole, round } = savedRim(document, operation);
  expect(hole.diameter.value).toBe(6);
  return { path, operation, document, rawBytes, holeId: hole.id, roundId: round.id, radius: 3 };
}

/** Actual fresh Node OCCT/cache, not a claim about browser Worker ownership or GPU residency. */
export async function inspectFreshNativeHoleRim(scenario: SavedHoleRimScenario, info: TestInfo): Promise<void> {
  const document = savedDocument(await readFile(scenario.path));
  expect(document).toEqual(scenario.document);
  const { hole, round, target } = savedRim(document, scenario.operation);
  expect(hole.id).toBe(scenario.holeId); expect(round.id).toBe(scenario.roundId);
  expect(hole.diameter.value).toBe(scenario.radius * 2);
  const plan = resolvePart(document);
  expect(plan.errors).toEqual([]);
  const inputs = plan.steps.filter(step => step.featureId === hole.id);
  expect(inputs).toHaveLength(1);
  const items = inputs.map(step => ({ id: step.featureId, key: step.key }));
  const cache = createShapeCache<CachedSolid>(undefined,
    ({ mesh }) => mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + mesh.edgePositions.byteLength,
    ({ mesh }) => solidMeshBuffers(mesh));
  const api = createKernelApi(loadOcctForNode, cache);
  const bridge = createDirectKernelBridge(api);
  const partId = `r18-rim-native-${document.id}-${scenario.radius}`;
  const owner: CurrentMeshOwner = { dispatchId: `${partId}-input-borrow`, partId, generation: 1, kind: 'hidden', steps: items };
  let borrowed = false;
  const failures: unknown[] = [];
  let bodyFailed = false;
  try {
    const outcome = await bridge.recomputeSolids(plan.steps, { partId, generation: 1 });
    expect(outcome.failures).toEqual([]); expect(outcome.cancelled).toBe(false);
    const output = outcome.bodies.find(body => body.featureId === round.id);
    if (output === undefined) throw new Error('Actual native rim output missing');
    expect(output.volume).toBeCloseTo(holeRimVolume(scenario.operation, scenario.radius), 5);
    const expectedSurface = scenario.operation === 'C面取り' ? 'cone' : 'torus';
    expect(output.faces.some(face => face.surfaceKind === expectedSurface)).toBe(true);
    borrowed = true;
    const raw = await api.readCachedBodies(items, { owner, limitBytes: 512 * 1024 * 1024 });
    expect(raw.failures).toEqual([]); expect(raw.cancelled).toBe(false);
    expect(raw.bodies.map(body => body.id)).toEqual([hole.id]);
    if (typeof bridge.readCachedBodies !== 'function') throw new Error('Actual input cache read unavailable');
    const cached = await bridge.readCachedBodies(plan.steps, [hole.id]);
    expect(cached.failures).toEqual([]); expect(cached.cancelled).toBe(false);
    const input = cached.bodies.find(body => body.featureId === hole.id);
    if (input?.origins?.state !== 'tracked') throw new Error('Actual consumed Hole origins unavailable');
    expect(input.volume).toBeCloseTo(12000 - 10 * Math.PI * scenario.radius ** 2, 5);
    const match = resolveSubShapeReference(input, target);
    expect(match.status).toBe('matched');
    if (match.status !== 'matched' || match.match.geometry.kind !== 'edge')
      throw new Error('Actual consumed Hole rim did not uniquely resolve');
    const geometry = match.match.geometry;
    const matchedIndex = match.match.reference.index;
    expect(geometry.curveKind).toBe('circle');
    expect(geometry.radius).toBeCloseTo(scenario.radius, 5);
    const binding = input.origins.bindings.filter(item => {
      if (item.state !== 'unique' && item.state !== 'merged') return false;
      return item.current.kind === 'edge' && item.current.index === matchedIndex;
    });
    expect(binding).toHaveLength(1);
    const unique = binding[0];
    if (unique?.state !== 'unique' || unique.origin.identity.kind !== 'face-intersection-edge')
      throw new Error('Actual rim semantic binding is absent or ambiguous');
    expect(unique.origin.identity).toEqual(target.origin?.identity);
    // The consumed input reference must not silently adopt the distinct output owner.
    expect(resolveSubShapeReference(output, target).status).toBe('missing');
    await info.attach(`r18-rim-native-${scenario.operation}-${scenario.radius}.json`, {
      body: Buffer.from(JSON.stringify({ partId, holeId: hole.id, roundId: round.id,
        inputSemanticOwner: unique.origin.identity, nativeSurface: expectedSurface, nativeVolume: output.volume,
        independentVolume: holeRimVolume(scenario.operation, scenario.radius),
        torusMajorMinorRadii: 'unknown: not exposed by SolidFaceInfo',
        browserWorkerOwnershipCertified: false, gpuResidentCertified: false }, null, 2)), contentType: 'application/json' });
  } catch (error) { failures.push(error); bodyFailed = true; }
  finally {
    try {
      if (borrowed) {
        if (typeof api.releaseReferenceMeshLease !== 'function') {
          failures.push(new Error('Actual hidden lease return unavailable'));
        } else {
          const result = await api.releaseReferenceMeshLease(owner);
          expect(result.released || (bodyFailed && result.absent === true)).toBe(true);
        }
      }
    } catch (error) { failures.push(error); }
    try { await api.releasePart(partId); } catch (error) { failures.push(error); }
    try { bridge.dispose(); } catch (error) { failures.push(error); }
    try { cache.clear(); expect(cache.size).toBe(0); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Actual rim native body/cleanup failed');
}

/** Full owned process has been stopped by the spec before entering this actual ZIP reopen. */
export async function reopenHoleRimScenario(page: Page, info: TestInfo, scenario: SavedHoleRimScenario,
  app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await openActualR18File(page, scenario.path, app);
  await expectRimUiVolume(page, scenario.operation, scenario.radius);
  const hole = savedRim(scenario.document, scenario.operation).hole;
  await treeRow(page, '穴1').click();
  const diameter = propertyPanel(page).locator('.pcad-field').filter({
    has: page.locator('.pcad-field__label', { hasText: /^直径$/u }),
  }).locator('input.pcad-field__input');
  await expect(diameter).toHaveValue(hole.diameter.source);
  const raw = await saveUiPart(page, info.outputPath(`rim-${scenario.operation}-${scenario.radius}-cold.pcad`), app);
  expect(savedDocument(raw)).toEqual(scenario.document);
  await assertDerivedThumbnailPair(page, info, scenario.rawBytes, raw, `rim-${scenario.operation}-${scenario.radius}-cold`);
}

export async function updateHoleRimPhi8Scenario(page: Page, info: TestInfo, scenario: SavedHoleRimScenario,
  app?: ElectronApplication): Promise<SavedHoleRimScenario> {
  expect(scenario.radius).toBe(3);
  await treeRow(page, '穴1').click();
  const diameter = propertyPanel(page).locator('.pcad-field').filter({
    has: page.locator('.pcad-field__label', { hasText: /^直径$/u }),
  }).locator('input.pcad-field__input');
  await expect(diameter).toHaveValue('6');
  const token = await beginRecompute(page);
  await diameter.fill('2*4');
  await treeRow(page, `${scenario.operation}1`).click();
  await waitForRecompute(page, token); await waitForSettledRecompute(page);
  await expectRimUiVolume(page, scenario.operation, 4);
  const path = info.outputPath(`actual-rim-${scenario.operation}-phi8.pcad`);
  const rawBytes = await saveUiPart(page, path, app);
  const document = savedDocument(rawBytes);
  const original = savedRim(scenario.document, scenario.operation);
  const updated = savedRim(document, scenario.operation);
  expect(updated.hole.id).toBe(scenario.holeId); expect(updated.round.id).toBe(scenario.roundId);
  expect(updated.hole.diameter.source).toBe('2*4'); expect(updated.hole.diameter.value).toBe(8);
  expect(updated.round).toEqual(original.round);
  expect(document).toEqual({ ...scenario.document, solids: scenario.document.solids.map(item =>
    item.id === scenario.holeId ? { ...original.hole, diameter: updated.hole.diameter } : item) });
  // A single committed expression edit must be exactly one Undo/Redo, not an injected history state.
  await page.locator('canvas.pcad-viewport__canvas').focus();
  let historyToken = await beginRecompute(page);
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, historyToken); await waitForSettledRecompute(page);
  await expectRimUiVolume(page, scenario.operation, 3);
  expect(savedDocument(await saveUiPart(page, info.outputPath(`rim-${scenario.operation}-undo.pcad`), app))).toEqual(scenario.document);
  await page.locator('canvas.pcad-viewport__canvas').focus();
  historyToken = await beginRecompute(page);
  await page.keyboard.press('Control+y');
  await waitForRecompute(page, historyToken); await waitForSettledRecompute(page);
  await expectRimUiVolume(page, scenario.operation, 4);
  expect(savedDocument(await saveUiPart(page, info.outputPath(`rim-${scenario.operation}-redo.pcad`), app))).toEqual(document);
  return { ...scenario, path, document, rawBytes, radius: 4 };
}


// Independent A phi8 / unchanged B phi6; original shared and legacy functions remain byte-exact.
export async function inspectIndependentHoleWallMatePhi8(scenario: SavedHoleWallMateScenario,
  stats: AssemblyBrowserStats = scenario.solved): Promise<void> {
  const api = createKernelApi(loadOcctForNode);
  const partId = `r18-wallmate-native-${scenario.holeId}`;
  const bridge = createDirectKernelBridge(api);
  try {
    const axes: { point: Vec3; direction: Vec3 }[] = [];
    const mate = scenario.bundle.document.mates[0];
    if (mate === undefined) throw new Error('Missing saved mate');
    for (const target of [mate.a, mate.b]) {
      if (target.kind !== 'subShape') throw new Error('Expected a real selected wall');
      const component = scenario.bundle.document.components.find(item => item.id === target.componentId);
      if (component?.source.kind !== 'part') throw new Error('Missing component part');
      const document = scenario.bundle.parts.get(component.source.partRef);
      if (document === undefined) throw new Error('Missing embedded saved part');
      const resolved = resolvePart(document);
      expect(resolved.errors).toEqual([]);
      const outcome = await bridge.recomputeSolids(resolved.steps, { partId, generation: axes.length + 1 });
      expect(outcome.failures).toEqual([]);
      expect(outcome.cancelled).toBe(false);
      const body = outcome.bodies.find(item => item.featureId === target.ref.bodyFeatureId);
      if (body === undefined) throw new Error('Missing actual current hole body');
      const firstSource = scenario.bundle.document.components[0]?.source;
      if (firstSource?.kind !== 'part') throw new Error('Independent source A missing');
      const radius = component.source.partRef === firstSource.partRef ? 4 : 3;
      const hole = document.solids.find(item => item.id === target.ref.bodyFeatureId);
      if (hole?.kind !== 'hole') throw new Error('Independent native hole missing');
      expect(hole.diameter.value).toBe(radius * 2);
      expect(hole.diameter.source).toBe(radius === 4 ? '2*4' : '6');
      expect(body.volume).toBeCloseTo(12000 - 10 * Math.PI * radius * radius, 5);
      const match = resolveSubShapeReference(body, target.ref);
      expect(match.status).toBe('matched');
      if (match.status !== 'matched') throw new Error('Saved wall cannot be uniquely resolved');
      const geometry = match.match.geometry;
      if (geometry.kind !== 'face' || geometry.surfaceKind !== 'cylinder'
        || geometry.axis === null || geometry.axisOrigin === undefined) throw new Error('Native cylindrical axis unavailable');
      expect(geometry.radius).toBeCloseTo(radius, 5);
      expect(match.match.reference.origin).toEqual(target.ref.origin);
      if (body.origins?.state !== 'tracked' || target.ref.origin === undefined)
        throw new Error('Actual current hole/rim origin proof unavailable');
      const savedOrigin = target.ref.origin;
      if (savedOrigin.shapeKind !== 'face') throw new Error('Saved wall identity must be a face');
      const rims = body.origins.bindings.filter(binding => binding.state === 'unique'
        && binding.origin.shapeKind === 'edge' && binding.origin.identity.kind === 'face-intersection-edge'
        && binding.origin.identity.faces.some(face => isDeepStrictEqual(face, savedOrigin.identity)));
      expect(rims).toHaveLength(2);
      for (const rim of rims) {
        if (rim.state !== 'unique' || rim.current.kind !== 'edge') throw new Error('Actual current rim not unique');
        const index = rim.current.index;
        const edge = body.edges.find(item => item.index === index);
        expect(edge?.curveKind).toBe('circle');
        expect(edge?.radius).toBeCloseTo(radius, 5);
      }
      const actual = stats.components.find(item => item.id === target.componentId)?.resolved;
      if (actual === null || actual === undefined || actual.position.length !== 3 || actual.rotation.length !== 4)
        throw new Error('Actual solved placement unavailable');
      const [px, py, pz] = actual.position;
      const [qx, qy, qz, qw] = actual.rotation;
      if (px === undefined || py === undefined || pz === undefined || qx === undefined
        || qy === undefined || qz === undefined || qw === undefined) throw new Error('Incomplete solved pose');
      const position: Vec3 = [px, py, pz];
      const rotation: Quaternion = [qx, qy, qz, qw];
      axes.push({ point: applyPlacementToPoint({ position, rotation }, geometry.axisOrigin),
        direction: applyPlacementToDirection({ position, rotation }, geometry.axis) });
    }
    const [a, b] = axes;
    if (a === undefined || b === undefined) throw new Error('Two native axes required');
    const cross = (x: Vec3, y: Vec3): Vec3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const offset: Vec3 = [b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]];
    expect(Math.hypot(...cross(a.direction, b.direction))).toBeLessThanOrEqual(1e-9);
    expect(Math.hypot(...cross(offset, a.direction)) / Math.hypot(...a.direction)).toBeLessThanOrEqual(1e-9);
    // Concentric leaves translation along and rotation about the axis free.
  } finally {
    try { await api.releasePart(partId); } finally { bridge.dispose(); }
  }
}

export async function updateIndependentHoleWallMatePhi8Scenario(page: Page, info: TestInfo,
  scenario: SavedHoleWallMateScenario, app?: ElectronApplication, confirmationAcceptance = false): Promise<SavedHoleWallMateScenario> {
  const originalPartBytes = new Uint8Array(await readFile(scenario.inputPartPath));
  const partRef = scenario.bundle.document.components[0]?.source;
  if (partRef?.kind !== 'part') throw new Error('Missing independent source A');
  if (confirmationAcceptance) throw new Error('Legacy shared-source confirmation uses its original dedicated test');
  const otherSource = scenario.bundle.document.components[1]?.source;
  if (otherSource?.kind !== 'part' || otherSource.partRef === partRef.partRef) throw new Error('Two independent saved sources required');
  expect(scenario.independentParts).toHaveLength(2);
  expect(scenario.bundle.parts.size).toBe(2);
  const untouchedPart = scenario.bundle.parts.get(otherSource.partRef);
  if (untouchedPart === undefined) throw new Error('Independent source B missing');
  await openActualR18File(page, scenario.inputPartPath, app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
  await treeRow(page, '穴1').click();
  const diameterBox = propertyPanel(page).locator('.pcad-field').filter({
    has: page.locator('.pcad-field__label', { hasText: /^直径$/u }),
  });
  const diameter = diameterBox.locator('input.pcad-field__input');
  await expect(diameter).toHaveValue('6');
  const editToken = await beginRecompute(page);
  await diameter.fill('2*4');
  await treeRow(page, '押し出し1').click();
  await waitForRecompute(page, editToken);
  await waitForSettledRecompute(page);
  await treeRow(page, '穴1').click();
  await expect(diameter).toHaveValue('2*4');
  await expect.poll(async () => Math.abs(Number((await volumeText(page).innerText()).replaceAll(',', '')
    .match(/[\d.]+/u)?.[0]) - (12000 - 160 * Math.PI)), { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
  const selectedFileName = confirmationAcceptance ? 'actual-$&-hole-wall-part-phi8.pcad' : 'actual-hole-wall-part-phi8.pcad';
  const updatedPartPath = info.outputPath(selectedFileName);
  const updatedPartBytes = await saveUiPart(page, updatedPartPath, app);
  const updatedPart = savedDocument(updatedPartBytes);
  const changedHole = updatedPart.solids.find(item => item.id === scenario.holeId);
  const originalHole = scenario.inputPart.solids.find(item => item.id === scenario.holeId);
  if (changedHole?.kind !== 'hole' || originalHole?.kind !== 'hole') throw new Error('Actual saved hole lost');
  expect(changedHole.diameter.source).toBe('2*4');
  expect(changedHole.diameter.value).toBe(8);
  expect(updatedPart).toEqual({ ...scenario.inputPart, solids: scenario.inputPart.solids.map(item =>
    item.id === scenario.holeId ? { ...originalHole, diameter: changedHole.diameter } : item) });
  const originalArchive = readArchive(originalPartBytes, { shouldExtract: () => true });
  const updatedArchive = readArchive(updatedPartBytes, { shouldExtract: () => true });
  if (!originalArchive.ok || !updatedArchive.ok) throw new Error('Actual source ZIP unreadable');
  expect([...updatedArchive.entries.keys()].sort()).toEqual([...originalArchive.entries.keys()].sort());
  for (const [name, bytes] of originalArchive.entries) {
    if (name !== PCAD_DOCUMENT_ENTRY && name !== 'thumbnail.png') assertExactBinary(updatedArchive.entries.get(name), bytes, name);
    if (name !== PCAD_DOCUMENT_ENTRY && name !== 'thumbnail.png') expect(updatedArchive.entries.get(name)).toEqual(bytes);
  }
  // The two edited documents were decoded above in full; the actual preview PNG is a new rendering.
  await info.attach('source-phi8-preview', { body: await page.screenshot(), contentType: 'image/png' });
  await openActualR18File(page, scenario.path, app);
  expect(await wallMateStats(page)).toEqual(scenario.solved);
  if (confirmationAcceptance) await exerciseLegacyConfirmationCancellation(page, info, scenario, updatedPartBytes, selectedFileName, app);
  await installAssemblyFileGateway(page, { parts: [{ fileName: selectedFileName, bytes: updatedPartBytes }] });
  const refreshStarted = Date.now();
  try {
    const section = page.locator('.pcad-tree__sections > li').filter({
      has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }),
    });
    await section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__more').first().click();
    const action = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '元の部品を取り込み直す', exact: true });
    await expect(action).toHaveAttribute('aria-disabled', 'false');
    const refreshToken = await beginRecompute(page);
    await action.click();
    const confirmation = page.getByRole('alertdialog', { name: '同じ元部品か確認', exact: true });
    if (!/^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(scenario.inputPart.id)) {
      // This is the actual legacy confirmation UI in SEM's separately reviewed identity candidate.
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText(scenario.inputPart.name);
      await expect(confirmation).toContainText(selectedFileName);
      await expect(confirmation.getByText(`選択ファイル: ${selectedFileName}`, { exact: true })).toBeVisible();
      if (confirmationAcceptance) {
        await expect(confirmation.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
        const approve = confirmation.getByRole('button', { name: '同じ元部品として更新する', exact: true });
        const bounds = await approve.boundingBox();
        if (bounds === null) throw new Error('Native confirmation approve has no real bounds');
        await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      } else {
        await confirmation.getByRole('button', { name: '同じ元部品として更新する', exact: true }).click();
      }
    }
    await expect(confirmation).toHaveCount(0);
    if (confirmationAcceptance) await assertNativeConfirmationClosed(page);
    await waitForRecompute(page, refreshToken);
    await waitForSettledRecompute(page);
  } finally {
    // Never use the placement/source picker gateway's synthetic save callback as saved-file evidence.
    await resetAssemblyFileGateway(page);
  }
  const refreshFinished = Date.now();
  const solved = await wallMateStats(page);
  expect(solved).toEqual(scenario.solved);
  expect(solved.diagnosis?.converged).toBe(true);
  expect(solved.diagnosis?.unresolvedMateIds).toEqual([]);
  const saveStarted = Date.now();
  const path = info.outputPath('actual-hole-wall-mate-phi8.pcada');
  const rawBytes = await saveUiPart(page, path, app);
  const saveFinished = Date.now();
  const bundle = await readWallMateBundle(rawBytes);
  expect(bundle.document).toEqual(scenario.bundle.document);
  expect(bundle.parts).toEqual(new Map([[partRef.partRef, updatedPart], [otherSource.partRef, untouchedPart]]));
  expect(bundle.parts.get(otherSource.partRef)).toEqual(untouchedPart);
  expect(bundle.assemblies).toEqual(scenario.bundle.assemblies);
  assertAttachmentBinary(bundle.partAttachments, scenario.bundle.partAttachments);
  expect(bundle.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(bundle.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  expect(bundle.partFiles).toHaveLength(scenario.bundle.partFiles.length);
  for (const entry of bundle.partFiles) {
    const previous = scenario.bundle.partFiles.find(item => item.ref === entry.ref);
    if (previous === undefined) throw new Error('Unexpected new source provenance');
    expect(entry).toMatchObject({ ref: previous.ref, fileName: previous.fileName, path: previous.path });
    const previousDigest = scenario.bundle.partAttachmentDigests.get(previous.ref);
    if (previousDigest === undefined) throw new Error('Previous source attachment digest missing');
    expect(bundle.partAttachmentDigests.get(entry.ref)).toBe(previousDigest);
    if (entry.ref === otherSource.partRef) {
      expect(entry).toEqual(previous);
      continue;
    }
    expect(entry.ref).toBe(partRef.partRef);
    expect(entry.contentHash).not.toBe(previous.contentHash);
    expect(new Date(entry.importedAt).toISOString()).toBe(entry.importedAt);
    expect(Date.parse(entry.importedAt)).toBeGreaterThanOrEqual(refreshStarted);
    expect(Date.parse(entry.importedAt)).toBeLessThanOrEqual(refreshFinished);
  }
  const updated: SavedHoleWallMateScenario = { ...scenario, path, rawBytes, bundle,
    inputPartPath: updatedPartPath, inputPart: updatedPart, solved, saveWindow: [saveStarted, saveFinished] };
  await inspectIndependentHoleWallMatePhi8(updated);
  // One actual Undo restores the shared library and every saved mate/joint/source record together.
  const undoToken = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, undoToken);
  await waitForSettledRecompute(page);
  expect(await wallMateStats(page)).toEqual(scenario.solved);
  const undoStarted = Date.now();
  const undoneBytes = await saveUiPart(page, info.outputPath('actual-hole-wall-mate-one-undo.pcada'), app);
  const undoFinished = Date.now();
  const undone = await readWallMateBundle(undoneBytes);
  expect(undone.document).toEqual(scenario.bundle.document);
  expect(undone.parts).toEqual(scenario.bundle.parts);
  expect(undone.assemblies).toEqual(scenario.bundle.assemblies);
  expect(undone.partFiles).toEqual(scenario.bundle.partFiles);
  assertAttachmentBinary(undone.partAttachments, scenario.bundle.partAttachments);
  expect(undone.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(undone.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  await assertDerivedThumbnailPair(page, info, scenario.rawBytes, undoneBytes, 'undo-resave');
  assertWallMateArchiveEqual(scenario.rawBytes, undoneBytes, scenario.saveWindow, [undoStarted, undoFinished], 'fresh-render');
  await inspectFreshNativeHoleWallMate({ ...scenario, bundle: undone, rawBytes: undoneBytes });
  // Restore the real saved updated file, not a synthetic document, for the following process-cold proof.
  await openActualR18File(page, updated.path, app);
  expect(await wallMateStats(page)).toEqual(solved);
  await inspectIndependentHoleWallMatePhi8(updated);
  return updated;
}

export async function reopenIndependentHoleWallMatePhi8Scenario(page: Page, info: TestInfo,
  scenario: SavedHoleWallMateScenario, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  assertExactBinary(new Uint8Array(await readFile(scenario.path)), scenario.rawBytes, 'saved archive');
  expect(new Uint8Array(await readFile(scenario.path))).toEqual(scenario.rawBytes);
  if (app !== undefined) await openTarget(app, scenario.path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== undefined) await (await chooser).setFiles(scenario.path);
  await waitForRecompute(page, token);
  await waitForSettledRecompute(page);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  const stats = await wallMateStats(page);
  expect(stats.mateIds).toEqual(scenario.solved.mateIds);
  expect(stats.components).toEqual(scenario.solved.components);
  expect(stats.components[0]).toEqual(scenario.before.components[0]);
  expect(stats.diagnosis?.converged).toBe(true);
  expect(stats.diagnosis?.unresolvedMateIds).toEqual([]);
  await inspectIndependentHoleWallMatePhi8(scenario, stats);
  await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
  await info.attach('hole-wall-mate-phi8-cold', { body: await page.screenshot(), contentType: 'image/png' });
  const saveStarted = Date.now();
  const output = await saveUiPart(page, info.outputPath('actual-hole-wall-mate-phi8-reopened.pcada'), app);
  const saveFinished = Date.now();
  const bundle = await readWallMateBundle(output);
  expect(bundle.document).toEqual(scenario.bundle.document);
  expect(bundle.parts).toEqual(scenario.bundle.parts);
  expect(bundle.assemblies).toEqual(scenario.bundle.assemblies);
  expect(bundle.partFiles).toEqual(scenario.bundle.partFiles);
  assertAttachmentBinary(bundle.partAttachments, scenario.bundle.partAttachments);
  expect(bundle.partAttachments).toEqual(scenario.bundle.partAttachments);
  expect(bundle.partAttachmentDigests).toEqual(scenario.bundle.partAttachmentDigests);
  await assertDerivedThumbnailPair(page, info, scenario.rawBytes, output, 'cold-resave');
  assertWallMateArchiveEqual(scenario.rawBytes, output, scenario.saveWindow, [saveStarted, saveFinished], 'fresh-render');
}
