import { readFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem, installAssemblyFileGateway, readAssemblyStats,
  resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { componentRows, disableFilePickers, goHome, homeViewPagePoint, placeQueuedPart, selectComponent } from './boltedJointTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { cancelPopover, clickWorldPoint, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace,
  popover, popoverInputs, popoverTitle, propertyPanel, selectionKindLabel, sketchTool,
  topFaceCenter, treeRow, type WorldPoint } from './solidCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { readViewportRenderStats } from './viewportRenderStats.js';
import { uiMessage } from './uiMessages.js';
import { choosePlaneMenuItem, commitPopover as commitReference } from './workPlaneCaptureSupport.js';
import { EX18_A6, EX18_A8, EX18_B6, EX18_B8, EX18_B_BLANK, EX18_B_BLANK20, EX18_C3, EX18_C10, EX18_C5, EX18_BLANK8, EX18_BLANK10, ex18BytesSha, ex18ReadAssembly, ex18ReadPart,
  expectEx18AssemblyPart, expectEx18Part } from './ex18RoutesOracle.js';

export const EX18_A_ROUTES = ['a', 'b', 'c', 'd', 'e'] as const;
export type Ex18ARoute = typeof EX18_A_ROUTES[number];
const CORNERS: readonly WorldPoint[] = [
  [0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0],
  [0, 0, 10], [40, 0, 10], [40, 30, 10], [0, 30, 10],
];
const FACE_LOOPS = [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 6, 5],
  [4, 3, 7, 8], [1, 4, 8, 5], [2, 3, 7, 6]] as const;

function solidRow(page: Page, name: string): Locator {
  return page.locator('.pcad-tree__sections > li').filter({ hasText: 'ソリッド' })
    .getByRole('button', { name, exact: true });
}
function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page).locator('.pcad-field').filter({
    has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`, 'u') }),
  }).locator('input.pcad-field__input');
}
async function setExpression(page: Page, name: string, label: string, expression: string): Promise<void> {
  const token = await beginRecompute(page);
  await propertyField(page, label).fill(expression);
  await solidRow(page, name).click();
  await waitForRecompute(page, token);
  await expect(propertyField(page, label)).toHaveValue(expression);
}
async function savePart(page: Page, info: TestInfo, route: Ex18ARoute, stage: string,
  app?: ElectronApplication): Promise<Uint8Array> {
  await waitForSettledRecompute(page);
  return new Uint8Array(await saveFlowFile(page, info.outputPath(`ex18-A-${route}-${stage}.pcad`), app));
}
async function sketchPlate(page: Page, thickness: string): Promise<void> {
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', thickness);
  await waitForSettledRecompute(page);
  await expect(solidRow(page, '押し出し1')).toBeVisible();
}
async function plotPoints(page: Page, points: readonly (readonly string[])[]): Promise<void> {
  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  for (const point of points) { await fillFields(page, point); await commitPopover(page); }
  await cancelPopover(page);
}
async function sewnPlate(page: Page): Promise<void> {
  await plotPoints(page, CORNERS.map(point => point.map(String)));
  for (const [index, loop] of FACE_LOOPS.entries()) {
    await waitForSettledRecompute(page);
    await sketchTool(page, '選択').click();
    await treeRow(page, `点${String(loop[0])}`).click();
    for (const point of loop.slice(1)) await treeRow(page, `点${String(point)}`).click({ modifiers: ['Shift'] });
    await page.locator('canvas.pcad-viewport__canvas').press('Shift+F10');
    const menu = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
    const item = menu.locator('[data-command-id="sketch.faceFromPoints"]');
    await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    const token = await beginRecompute(page);
    await item.click(); await waitForRecompute(page, token);
    await expect(treeRow(page, `面${String(index + 1)}`)).toBeVisible();
  }
  await treeRow(page, '面1').click();
  for (let index = 2; index <= 6; index++) await treeRow(page, `面${String(index)}`).click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '作る', '縫合');
  await expect(popoverTitle(page)).toHaveText('つなぐ');
  const token = await beginRecompute(page);
  await commitPopover(page); await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
  await expect(solidRow(page, '縫合1')).toBeVisible();
}
async function mathPlate(page: Page): Promise<void> {
  await chooseToolMenuItem(page, '作る', '箱');
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['4*10', '3*10', '2*5']);
  const token = await beginRecompute(page);
  await commitPopover(page); await waitForRecompute(page, token);
  if (await popover(page).count() > 0) await cancelPopover(page);
  await solidRow(page, '箱1').click();
  await expect(propertyField(page, 'X の長さ')).toHaveValue('4*10');
  await setExpression(page, '箱1', 'X', '(4*10)/2');
  await setExpression(page, '箱1', 'Y', '30/2');
  await setExpression(page, '箱1', 'Z', '10/2');
}

async function stepPlate(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await sketchPlate(page, '8');
  await solidRow(page, '押し出し1').click();
  const authoredSeed = await savePart(page, info, 'c', 'authored-seed8', app);
  await expectEx18Part(authoredSeed, EX18_BLANK8, info, 'c-authored-seed8');
  const stepPath = info.outputPath('ex18-A-c-blank8.step');
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '書き出す');
  const panel = page.locator('.pcad-exchange');
  await panel.getByRole('radio', { name: 'STEP', exact: true }).click();
  if (app !== undefined) await saveTarget(app, stepPath);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await panel.getByRole('button', { name: '書き出す', exact: true }).click();
  if (download !== undefined) await (await download).saveAs(stepPath); else await diskFile(stepPath);
  await expect(panel).toHaveCount(0);
  const stepBytes = new Uint8Array(await readFile(stepPath));
  expect(new TextDecoder().decode(stepBytes.subarray(0, 15))).toContain('ISO-10303-21');
  const exportedSha = ex18BytesSha(stepBytes);
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
  if (app !== undefined) await openTarget(app, stepPath);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '読み込む');
  const token = await beginRecompute(page);
  await page.getByRole('form', { name: '読み込み', exact: true })
    .getByRole('button', { name: 'ファイルを選ぶ', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(stepPath);
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  const importedSeed = await savePart(page, info, 'c', 'imported-seed8', app);
  await expectEx18Part(importedSeed, EX18_BLANK8, info, 'c-imported-seed8');
  const imported = ex18ReadPart(importedSeed).document.solids.find(feature => feature.kind === 'importedSolid');
  if (imported?.kind !== 'importedSolid') throw new Error('EX18 ordinary STEP import did not create an imported body');
  expect(imported.source.format).toBe('step');
  expect(imported.source.fileName).toBe('ex18-A-c-blank8.step');
  expect(ex18BytesSha(new Uint8Array(await readFile(stepPath)))).toBe(exportedSha);
  await info.attach('ex18-c-actual-step-input', { path: stepPath, contentType: 'application/step' });
  await info.attach('ex18-c-step-identity', { body: JSON.stringify({ exportedSha, importedId: imported.id,
    source: imported.source, seedDocumentId: ex18ReadPart(authoredSeed).document.id,
    importedDocumentId: ex18ReadPart(importedSeed).document.id }), contentType: 'application/json' });
  await sketchTool(page, '選択').click();
  await page.locator('canvas.pcad-viewport__canvas').press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, topFaceCenter(8));
  await chooseToolMenuItem(page, '加工', '面の移動');
  await expect(popoverTitle(page)).toHaveText('面を動かす');
  await fillFields(page, ['2']);
  const edit = await beginRecompute(page);
  await commitPopover(page); await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, edit);
  await expect(solidRow(page, '面の移動1')).toBeVisible();
}

async function referenceHolePoint(page: Page): Promise<string> {
  await choosePlaneMenuItem(page, '基準点');
  await expect(popoverTitle(page)).toHaveText('基準点の決め方');
  await commitReference(page);
  await expect(popoverTitle(page)).toHaveText('基準点の位置');
  await fillFields(page, ['10', '15', '10']); await commitReference(page);
  if (await popover(page).count() > 0) await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await expect(sketchTool(page, '選択')).toHaveAttribute('aria-pressed', 'true');
  await waitForSettledRecompute(page);
  const referenceSection = page.locator('.pcad-tree__sections > li').filter({ hasText: '基準' });
  const reference = referenceSection.getByRole('button', { name: '基準点1', exact: true });
  await expect(reference).toHaveCount(1);
  await expect(reference).toBeVisible(); await reference.click();
  await page.locator('canvas.pcad-viewport__canvas').press('Shift+F10');
  const command = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true })
    .locator('[data-command-id="sketch.pointAtReference"]');
  await expect(command).not.toHaveAttribute('aria-disabled', 'true');
  const token = await beginRecompute(page); await command.click(); await waitForRecompute(page, token);
  await expect(treeRow(page, '点1')).toBeVisible();
  return '点1';
}

async function beginHole(page: Page, pointName: string): Promise<void> {
  await sketchTool(page, '選択').click();
  await page.locator('canvas.pcad-viewport__canvas').press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, topFaceCenter(10));
  await treeRow(page, pointName).click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '加工', '穴');
  await expect(popoverTitle(page)).toHaveText('穴をあける');
}
async function drillWithRefusalAndCancel(page: Page, info: TestInfo, route: Ex18ARoute,
  pointName: string, app?: ElectronApplication): Promise<ReturnType<typeof ex18ReadPart>['document']> {
  const before = ex18ReadPart(await savePart(page, info, route, 'before-hole', app)).document;
  await beginHole(page, pointName);
  await fillFields(page, ['0']); await commitPopover(page);
  await expect(popover(page)).toBeVisible();
  await expect(popoverInputs(page).first()).toHaveAttribute('aria-invalid', 'true');
  await expect(popover(page).locator('.pcad-field__message--error').first()).toBeVisible();
  await expect(popover(page).locator('.pcad-field__message--error').first()).not.toBeEmpty();
  await expect(solidRow(page, '穴1')).toHaveCount(0);
  await cancelPopover(page);
  expect(ex18ReadPart(await savePart(page, info, route, 'after-hole-refusal-cancel', app)).document).toEqual(before);
  await beginHole(page, pointName);
  await expect(popoverInputs(page).first()).toHaveValue('6');
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  const token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  await expect(solidRow(page, '穴1')).toBeVisible();
  return before;
}

async function partContract(page: Page, info: TestInfo, route: Ex18ARoute,
  beforeHole: ReturnType<typeof ex18ReadPart>['document'], app?: ElectronApplication) {
  const initial = await savePart(page, info, route, 'diameter6', app);
  await expectEx18Part(initial, EX18_A6, info, `${route}-diameter6`);
  const original = ex18ReadPart(initial).document;
  const initialHole = original.solids.find(feature => feature.kind === 'hole');
  if (initialHole?.kind !== 'hole') throw new Error('EX18 authored hole missing');
  // Creating the hole is one atomic edit, independently of the later diameter edit.
  await sketchTool(page, '選択').click();
  let token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const creationUndone = await savePart(page, info, route, 'creation-one-undo', app);
  expect(ex18ReadPart(creationUndone).document).toEqual(beforeHole);
  await expectEx18Part(creationUndone, EX18_BLANK10, info, `${route}-creation-one-undo`);
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  expect(ex18ReadPart(await savePart(page, info, route, 'creation-one-redo', app)).document).toEqual(original);
  await solidRow(page, '穴1').click();
  await setExpression(page, '穴1', '直径', '8');
  const edited = await savePart(page, info, route, 'diameter8', app);
  const editedDocument = ex18ReadPart(edited).document;
  expect(editedDocument.id).toBe(original.id);
  expect(editedDocument.solids.map(feature => feature.id)).toEqual(original.solids.map(feature => feature.id));
  expect(editedDocument.solids.find(feature => feature.id === initialHole.id)).toMatchObject({ kind: 'hole', diameter: { source: '8' } });
  await expectEx18Part(edited, EX18_A8, info, `${route}-diameter8`);
  await sketchTool(page, '選択').click();
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const undone = await savePart(page, info, route, 'one-undo6', app);
  expect(ex18ReadPart(undone).document).toEqual(original);
  await expectEx18Part(undone, EX18_A6, info, `${route}-one-undo6`);
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  const redone = await savePart(page, info, route, 'one-redo8', app);
  expect(ex18ReadPart(redone).document).toEqual(editedDocument);
  await expectEx18Part(redone, EX18_A8, info, `${route}-one-redo8`);
  if (route === 'c') {
    await fileAction(page, '新規').click();
    await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
    await waitForSettledRecompute(page);
  }
  await openSaveFlowFile(page, info.outputPath(`ex18-A-${route}-one-redo8.pcad`), app);
  await solidRow(page, '穴1').click(); await expect(propertyField(page, '直径')).toHaveValue('8');
  const reopened = await savePart(page, info, route, 'reopened8', app);
  expect(ex18ReadPart(reopened).document).toEqual(editedDocument);
  await expectEx18Part(reopened, EX18_A8, info, `${route}-reopened8`);
  return reopened;
}

/** Route e creates BOTH source parts and the assembly through ordinary UI; gateway queues actual saved bytes only. */
async function contextContract(page: Page, info: TestInfo, bracket: Uint8Array, app?: ElectronApplication): Promise<void> {
  const reference = ex18ReadPart(bracket).document.references.find(feature => feature.kind === 'referencePoint');
  if (reference?.kind !== 'referencePoint') throw new Error('EX18 UI reference point missing');
  await fileAction(page, '新規').click();
  await chooseToolMenuItem(page, '作る', '球');
  await expect(popoverTitle(page)).toHaveText('球を置く'); await fillFields(page, ['2']);
  let token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
  if (await popover(page).count() > 0) await cancelPopover(page);
  const sphere = await savePart(page, info, 'e', 'source-sphere', app);
  token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [
    { fileName: 'ex18-authored-A.pcad', bytes: bracket }, { fileName: 'ex18-authored-sphere.pcad', bytes: sphere },
  ] });
  try {
    await placeQueuedPart(page, ['0', '0', '0']); await placeQueuedPart(page, ['10', '15', '10']);
  } finally { await resetAssemblyFileGateway(page); }
  await selectComponent(page, 0);
  const form = page.getByTestId('assembly-context-form'); await expect(form).toBeVisible();
  await page.getByTestId('assembly-context-point').selectOption({ label: reference.name });
  await expect(page.getByTestId('assembly-context-face').locator('option')).toHaveCount(2);
  await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
  token = await beginRecompute(page);
  await form.getByRole('button', { name: '参照を作る', exact: true }).click(); await waitForRecompute(page, token);
  await expect(form.getByRole('alert')).toHaveCount(0);
  const linkedPath = info.outputPath('ex18-A-e-linked.pcada');
  const linked = new Uint8Array(await saveFlowFile(page, linkedPath, app));
  const linkedState = await expectEx18AssemblyPart(linked, EX18_A8, info, 'e-linked8');
  expect(linkedState.document.contextReferences).toHaveLength(1);
  // Move the real source component; its placement is an independent input to the reference resolver.
  await page.locator('canvas.pcad-viewport__canvas').press('4');
  const from = await homeViewPagePoint(page, [10, 15, 12]);
  const to = await homeViewPagePoint(page, [12, 15, 12]);
  await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(to[0], to[1], { steps: 8 });
  token = await beginRecompute(page); await page.mouse.up(); await waitForRecompute(page, token);
  const sourcePosition = (await readAssemblyStats(page)).components[1]?.resolved?.position;
  if (sourcePosition === undefined || sourcePosition.length !== 3) throw new Error('EX18 moved source pose missing');
  expect(Math.abs(sourcePosition[0] - 10)).toBeGreaterThan(0.5);
  const beforeUpdate = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-A-e-before-update.pcada'), app));
  await expectEx18AssemblyPart(beforeUpdate, EX18_A8, info, 'e-manual-update-not-automatic');
  await selectComponent(page, 0); token = await beginRecompute(page);
  await page.getByTestId('assembly-context-update').click(); await waitForRecompute(page, token);
  const updated = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-A-e-updated.pcada'), app));
  const movedExpected = { ...EX18_A8, holes: [{ axisOrigin: [sourcePosition[0], sourcePosition[1], 0] as const,
    direction: [0, 0, 1] as const, radius: 4 }] };
  const updatedState = await expectEx18AssemblyPart(updated, movedExpected, info, 'e-updated-real-hole');
  expect(updatedState.document.contextReferences?.map(link => link.id))
    .toEqual(linkedState.document.contextReferences?.map(link => link.id));
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const undone = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-A-e-update-undone.pcada'), app));
  const beforeBundle = await ex18ReadAssembly(beforeUpdate), undoneBundle = await ex18ReadAssembly(undone);
  expect(undoneBundle.document).toEqual(beforeBundle.document);
  expect([...undoneBundle.embeddedDocuments]).toEqual([...beforeBundle.embeddedDocuments]);
  await expectEx18AssemblyPart(undone, EX18_A8, info, 'e-update-one-undo');
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  const finalPath = info.outputPath('ex18-A-e-update-redone.pcada');
  const redone = new Uint8Array(await saveFlowFile(page, finalPath, app));
  await expectEx18AssemblyPart(redone, movedExpected, info, 'e-update-one-redo');
  await openSaveFlowFile(page, finalPath, app);
  const reopened = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-A-e-assembly-reopened.pcada'), app));
  const redoneBundle = await ex18ReadAssembly(redone), reopenedBundle = await ex18ReadAssembly(reopened);
  expect(reopenedBundle.document).toEqual(redoneBundle.document);
  expect([...reopenedBundle.embeddedDocuments]).toEqual([...redoneBundle.embeddedDocuments]);
  await expectEx18AssemblyPart(reopened, movedExpected, info, 'e-assembly-reopened-real-hole');
}

export async function ex18ARoutesFlow(page: Page, info: TestInfo, entry: string, route: Ex18ARoute,
  app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableFilePickers(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry); await waitForStartupHealth(page, info);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  if (route === 'b') await sewnPlate(page);
  else if (route === 'c') await stepPlate(page, info, app);
  else if (route === 'd') await mathPlate(page);
  else await sketchPlate(page, '10');
  let pointName: string;
  if (route === 'e') pointName = await referenceHolePoint(page);
  else {
    await plotPoints(page, [route === 'd' ? ['40/4', '30/2', '2*5'] : ['10', '15', '10']]);
    pointName = route === 'b' ? '点9' : '点1';
  }
  const beforeHole = await drillWithRefusalAndCancel(page, info, route, pointName, app);
  const saved = await partContract(page, info, route, beforeHole, app);
  if (route === 'd') {
    const box = ex18ReadPart(saved).document.solids.find(feature => feature.kind === 'primitive');
    expect(box).toMatchObject({ kind: 'primitive', shape: { kind: 'box', sizeX: { source: '4*10' },
      sizeY: { source: '3*10' }, sizeZ: { source: '2*5' } } });
  }
  if (route === 'e') await contextContract(page, info, saved, app);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  expect(errors).toEqual([]);
}

/** B/a: a closed stepped hollow XZ section, rotated around the public world Z axis. */
export async function ex18BRevolveFlow(page: Page, info: TestInfo, entry: string,
  app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableFilePickers(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry); await waitForStartupHealth(page, info);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await choosePlaneMenuItem(page, 'XZ');
  await plotPoints(page, [['3', '0', '0'], ['15', '0', '0'], ['15', '0', '5'],
    ['10', '0', '5'], ['10', '0', '25'], ['3', '0', '25']]);
  await sketchTool(page, '選択').click();
  await waitForSettledRecompute(page);
  await treeRow(page, '点1').click();
  for (let index = 2; index <= 6; index++) await treeRow(page, `点${String(index)}`).click({ modifiers: ['Shift'] });
  await page.locator('canvas.pcad-viewport__canvas').press('Shift+F10');
  const command = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true })
    .locator('[data-command-id="sketch.faceFromPoints"]');
  await expect(command).not.toHaveAttribute('aria-disabled', 'true');
  let token = await beginRecompute(page); await command.click(); await waitForRecompute(page, token);
  await expect(treeRow(page, '面1')).toBeVisible();
  const save = async (stage: string): Promise<Uint8Array> => {
    await waitForSettledRecompute(page);
    return new Uint8Array(await saveFlowFile(page, info.outputPath(`ex18-B-a-${stage}.pcad`), app));
  };
  const before = ex18ReadPart(await save('before-revolve')).document;
  await treeRow(page, '面1').click(); await chooseToolMenuItem(page, '作る', '回転');
  await expect(popoverTitle(page)).toHaveText('回す');
  await expect(popover(page).getByRole('group', { name: '回転軸', exact: true })
    .getByRole('button', { name: 'Z', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await fillFields(page, ['0']); await commitPopover(page);
  await expect(popoverInputs(page).first()).toHaveAttribute('aria-invalid', 'true');
  await expect(popover(page).locator('.pcad-field__message--error').first()).toBeVisible();
  await expect(popover(page).locator('.pcad-field__message--error').first()).not.toBeEmpty();
  await expect(solidRow(page, '回転1')).toHaveCount(0);
  await cancelPopover(page);
  expect(ex18ReadPart(await save('refused-cancelled')).document).toEqual(before);
  await treeRow(page, '面1').click(); await chooseToolMenuItem(page, '作る', '回転');
  await expect(popoverTitle(page)).toHaveText('回す'); await fillFields(page, ['360']);
  token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  await expect(solidRow(page, '回転1')).toBeVisible();
  const initial = await save('diameter6'), original = ex18ReadPart(initial).document;
  expect(original.solids.map(feature => feature.kind)).toEqual(['revolve']);
  expect(original.solids[0]).toMatchObject({ kind: 'revolve', angle: { source: '360' },
    axis: { kind: 'world', axis: 'z' } });
  await expectEx18Part(initial, EX18_B6, info, 'B-a-diameter6');
  await sketchTool(page, '選択').click();
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  expect(ex18ReadPart(await save('creation-one-undo')).document).toEqual(before);
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  expect(ex18ReadPart(await save('creation-one-redo')).document).toEqual(original);
  // Two separately committed profile coordinates define the full-length inner radius.
  for (const name of ['点1', '点6']) {
    await treeRow(page, name).click(); await expect(propertyField(page, 'X')).toHaveValue('3');
    token = await beginRecompute(page); await propertyField(page, 'X').fill('4');
    await treeRow(page, name).click(); await waitForRecompute(page, token);
    await expect(propertyField(page, 'X')).toHaveValue('4');
  }
  const edited = await save('diameter8'), editedDocument = ex18ReadPart(edited).document;
  expect(editedDocument.id).toBe(original.id);
  expect(editedDocument.solids).toEqual(original.solids);
  expect(editedDocument.sketches[0].features.map(feature => feature.id))
    .toEqual(original.sketches[0].features.map(feature => feature.id));
  const radiusPoints = editedDocument.sketches[0].features.filter(feature => feature.kind === 'point'
    && (feature.name === '点1' || feature.name === '点6'));
  expect(radiusPoints).toHaveLength(2);
  for (const point of radiusPoints) expect(point).toMatchObject({ at: { mode: 'absolute', x: { source: '4' } } });
  await expectEx18Part(edited, EX18_B8, info, 'B-a-diameter8');
  await sketchTool(page, '選択').click();
  for (let index = 0; index < 2; index++) {
    token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
    await waitForRecompute(page, token);
  }
  const undone = await save('two-coordinate-undo6');
  expect(ex18ReadPart(undone).document).toEqual(original);
  await expectEx18Part(undone, EX18_B6, info, 'B-a-two-coordinate-undo6');
  for (let index = 0; index < 2; index++) {
    token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
    await waitForRecompute(page, token);
  }
  const redone = await save('two-coordinate-redo8');
  expect(ex18ReadPart(redone).document).toEqual(editedDocument);
  await expectEx18Part(redone, EX18_B8, info, 'B-a-two-coordinate-redo8');
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
  await openSaveFlowFile(page, info.outputPath('ex18-B-a-two-coordinate-redo8.pcad'), app);
  await expect(solidRow(page, '回転1')).toBeVisible();
  const reopened = await save('reopened8');
  expect(ex18ReadPart(reopened).document).toEqual(editedDocument);
  await expectEx18Part(reopened, EX18_B8, info, 'B-a-reopened8');
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  expect(errors).toEqual([]);
}

async function saveFlangePart(page: Page, info: TestInfo, route: Ex18ARoute, stage: string,
  app?: ElectronApplication): Promise<Uint8Array> {
  await waitForSettledRecompute(page);
  return new Uint8Array(await saveFlowFile(page, info.outputPath(`ex18-B-${route}-${stage}.pcad`), app));
}
async function beginFlangeHole(page: Page, pointName: string): Promise<void> {
  await sketchTool(page, '選択').click();
  await page.locator('canvas.pcad-viewport__canvas').press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [5, 0, 25]);
  await treeRow(page, pointName).click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '加工', '穴');
  await expect(popoverTitle(page)).toHaveText('穴をあける');
}
async function cylinderFlange(page: Page, formulas: boolean, stemHeight = '20'): Promise<void> {
  for (const [index, dimensions] of (formulas
    ? [['3*5', '10/2'], ['20/2', '2*10']]
    : [['15', '5'], ['10', stemHeight]]).entries()) {
    await chooseToolMenuItem(page, '作る', '円柱');
    await expect(popoverTitle(page)).toHaveText('円柱を置く');
    await fillFields(page, dimensions);
    const token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
    if (await popover(page).count() > 0) await cancelPopover(page);
    const name = `円柱${String(index + 1)}`;
    await solidRow(page, name).click();
    if (index === 1) await setExpression(page, name, 'Z', formulas ? '10/2' : '5');
  }
  await solidRow(page, '円柱1').click();
  await solidRow(page, '円柱2').click({ modifiers: ['Shift'] });
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, '合わせる', '和'); await waitForRecompute(page, token);
  await expect(popover(page)).toHaveCount(0); await expect(solidRow(page, '和1')).toBeVisible();
}
async function ruledFlange(page: Page): Promise<void> {
  for (const [index, section] of [['15', '0'], ['15', '5'], ['10', '5'], ['10', '25']].entries()) {
    await sketchTool(page, '選択').click();
    await page.getByRole('group', { name: 'スケッチ', exact: true }).locator('.pcad-menu__trigger').first().click();
    await page.locator('.pcad-menu__panel[aria-label="作図"]').getByRole('button', { name: '円', exact: true }).click();
    await expect(popoverTitle(page)).toHaveText('円の中心');
    await fillFields(page, ['0', '0', section[1]]); await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円の半径');
    await fillFields(page, [section[0]]); await commitPopover(page);
    if (await popover(page).count() > 0) await cancelPopover(page);
    await waitForSettledRecompute(page);
    await treeRow(page, `円弧${String(index + 1)}`).click();
    await sketchTool(page, '面').click(); await page.locator('canvas.pcad-viewport__canvas').press('Enter');
    await waitForSettledRecompute(page); await expect(treeRow(page, `面${String(index + 1)}`)).toBeVisible();
  }
  for (const [index, first] of [1, 3].entries()) {
    await sketchTool(page, '選択').click(); await treeRow(page, `面${String(first)}`).click();
    await treeRow(page, `面${String(first + 1)}`).click({ modifiers: ['Shift'] });
    await chooseToolMenuItem(page, '作る', '面をつなぐ');
    await expect(popoverTitle(page)).toHaveText('面をつなぐ');
    const token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
    if (await popover(page).count() > 0) await cancelPopover(page);
    await expect(solidRow(page, `面をつなぐ${String(index + 1)}`)).toBeVisible();
  }
  await solidRow(page, '面をつなぐ1').click();
  await solidRow(page, '面をつなぐ2').click({ modifiers: ['Shift'] });
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, '合わせる', '和'); await waitForRecompute(page, token);
  await expect(popover(page)).toHaveCount(0); await expect(solidRow(page, '和1')).toBeVisible();
}

async function referenceFlangePoint(page: Page): Promise<string> {
  await choosePlaneMenuItem(page, '基準点');
  await expect(popoverTitle(page)).toHaveText('基準点の決め方');
  await commitReference(page);
  await expect(popoverTitle(page)).toHaveText('基準点の位置');
  await fillFields(page, ['0', '0', '25']); await commitReference(page);
  if (await popover(page).count() > 0) await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await expect(sketchTool(page, '選択')).toHaveAttribute('aria-pressed', 'true');
  await waitForSettledRecompute(page);
  const referenceSection = page.locator('.pcad-tree__sections > li').filter({ hasText: '基準' });
  const reference = referenceSection.getByRole('button', { name: '基準点1', exact: true });
  await expect(reference).toHaveCount(1);
  await expect(reference).toBeVisible(); await reference.click();
  await page.locator('canvas.pcad-viewport__canvas').press('Shift+F10');
  const command = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true })
    .locator('[data-command-id="sketch.pointAtReference"]');
  await expect(command).not.toHaveAttribute('aria-disabled', 'true');
  const token = await beginRecompute(page); await command.click(); await waitForRecompute(page, token);
  await expect(treeRow(page, '点1')).toBeVisible();
  return '点1';
}
async function drillFlangeWithRefusalAndCancel(page: Page, info: TestInfo, route: Ex18ARoute,
  pointName: string, app?: ElectronApplication): Promise<ReturnType<typeof ex18ReadPart>['document']> {
  const before = ex18ReadPart(await saveFlangePart(page, info, route, 'before-hole', app)).document;
  await beginFlangeHole(page, pointName);
  await fillFields(page, ['0']); await commitPopover(page);
  await expect(popover(page)).toBeVisible();
  await expect(popoverInputs(page).first()).toHaveAttribute('aria-invalid', 'true');
  await expect(popover(page).locator('.pcad-field__message--error').first()).toBeVisible();
  await expect(popover(page).locator('.pcad-field__message--error').first()).not.toBeEmpty();
  await expect(solidRow(page, '穴1')).toHaveCount(0);
  await cancelPopover(page);
  expect(ex18ReadPart(await saveFlangePart(page, info, route, 'after-hole-refusal-cancel', app)).document).toEqual(before);
  await beginFlangeHole(page, pointName);
  await expect(popoverInputs(page).first()).toHaveValue('6');
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  const token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  await expect(solidRow(page, '穴1')).toBeVisible();
  return before;
}
async function flangeHoleContract(page: Page, info: TestInfo, route: Ex18ARoute,
  beforeHole: ReturnType<typeof ex18ReadPart>['document'], app?: ElectronApplication) {
  const initial = await saveFlangePart(page, info, route, 'diameter6', app);
  await expectEx18Part(initial, EX18_B6, info, `${route}-diameter6`);
  const original = ex18ReadPart(initial).document;
  const initialHole = original.solids.find(feature => feature.kind === 'hole');
  if (initialHole?.kind !== 'hole') throw new Error('EX18 authored hole missing');
  // Creating the hole is one atomic edit, independently of the later diameter edit.
  await sketchTool(page, '選択').click();
  let token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const creationUndone = await saveFlangePart(page, info, route, 'creation-one-undo', app);
  expect(ex18ReadPart(creationUndone).document).toEqual(beforeHole);
  await expectEx18Part(creationUndone, EX18_B_BLANK, info, `${route}-creation-one-undo`);
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  expect(ex18ReadPart(await saveFlangePart(page, info, route, 'creation-one-redo', app)).document).toEqual(original);
  await solidRow(page, '穴1').click();
  await setExpression(page, '穴1', '直径', '8');
  const edited = await saveFlangePart(page, info, route, 'diameter8', app);
  const editedDocument = ex18ReadPart(edited).document;
  expect(editedDocument.id).toBe(original.id);
  expect(editedDocument.solids.map(feature => feature.id)).toEqual(original.solids.map(feature => feature.id));
  expect(editedDocument.solids.find(feature => feature.id === initialHole.id)).toMatchObject({ kind: 'hole', diameter: { source: '8' } });
  await expectEx18Part(edited, EX18_B8, info, `${route}-diameter8`);
  await sketchTool(page, '選択').click();
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const undone = await saveFlangePart(page, info, route, 'one-undo6', app);
  expect(ex18ReadPart(undone).document).toEqual(original);
  await expectEx18Part(undone, EX18_B6, info, `${route}-one-undo6`);
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  const redone = await saveFlangePart(page, info, route, 'one-redo8', app);
  expect(ex18ReadPart(redone).document).toEqual(editedDocument);
  await expectEx18Part(redone, EX18_B8, info, `${route}-one-redo8`);
  {
    await fileAction(page, '新規').click();
    await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
    await waitForSettledRecompute(page);
  }
  await openSaveFlowFile(page, info.outputPath(`ex18-B-${route}-one-redo8.pcad`), app);
  await solidRow(page, '穴1').click(); await expect(propertyField(page, '直径')).toHaveValue('8');
  const reopened = await saveFlangePart(page, info, route, 'reopened8', app);
  expect(ex18ReadPart(reopened).document).toEqual(editedDocument);
  await expectEx18Part(reopened, EX18_B8, info, `${route}-reopened8`);
  return reopened;
}
async function flangeContextContract(page: Page, info: TestInfo, bracket: Uint8Array, app?: ElectronApplication): Promise<void> {
  const reference = ex18ReadPart(bracket).document.references.find(feature => feature.kind === 'referencePoint');
  if (reference?.kind !== 'referencePoint') throw new Error('EX18 UI reference point missing');
  await fileAction(page, '新規').click();
  await chooseToolMenuItem(page, '作る', '球');
  await expect(popoverTitle(page)).toHaveText('球を置く'); await fillFields(page, ['2']);
  let token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
  if (await popover(page).count() > 0) await cancelPopover(page);
  const sphere = await saveFlangePart(page, info, 'e', 'source-sphere', app);
  token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [
    { fileName: 'ex18-authored-B.pcad', bytes: bracket }, { fileName: 'ex18-authored-sphere.pcad', bytes: sphere },
  ] });
  try {
    await placeQueuedPart(page, ['0', '0', '0']); await placeQueuedPart(page, ['0', '0', '25']);
  } finally { await resetAssemblyFileGateway(page); }
  await selectComponent(page, 0);
  const form = page.getByTestId('assembly-context-form'); await expect(form).toBeVisible();
  await page.getByTestId('assembly-context-point').selectOption({ label: reference.name });
  await expect(page.getByTestId('assembly-context-face').locator('option')).toHaveCount(2);
  await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
  token = await beginRecompute(page);
  await form.getByRole('button', { name: '参照を作る', exact: true }).click(); await waitForRecompute(page, token);
  await expect(form.getByRole('alert')).toHaveCount(0);
  const linkedPath = info.outputPath('ex18-B-e-linked.pcada');
  const linked = new Uint8Array(await saveFlowFile(page, linkedPath, app));
  const linkedState = await expectEx18AssemblyPart(linked, EX18_B8, info, 'e-linked8');
  expect(linkedState.document.contextReferences).toHaveLength(1);
  // Move the real source component; its placement is an independent input to the reference resolver.
  await dragContextSource(page, [0, 0, 25]);
  const sourcePosition = (await readAssemblyStats(page)).components[1]?.resolved?.position;
  if (sourcePosition === undefined || sourcePosition.length !== 3) throw new Error('EX18 moved source pose missing');
  expect(Math.abs(sourcePosition[0] - 0)).toBeGreaterThan(0.5);
  const beforeUpdate = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-B-e-before-update.pcada'), app));
  await expectEx18AssemblyPart(beforeUpdate, EX18_B8, info, 'e-manual-update-not-automatic');
  await selectComponent(page, 0); token = await beginRecompute(page);
  await page.getByTestId('assembly-context-update').click(); await waitForRecompute(page, token);
  const updated = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-B-e-updated.pcada'), app));
  const movedExpected = { ...EX18_B8, holes: [{ axisOrigin: [sourcePosition[0], sourcePosition[1], 0] as const,
    direction: [0, 0, 1] as const, radius: 4 }] };
  const updatedState = await expectEx18AssemblyPart(updated, movedExpected, info, 'e-updated-real-hole');
  expect(updatedState.document.contextReferences?.map(link => link.id))
    .toEqual(linkedState.document.contextReferences?.map(link => link.id));
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const undone = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-B-e-update-undone.pcada'), app));
  const beforeBundle = await ex18ReadAssembly(beforeUpdate), undoneBundle = await ex18ReadAssembly(undone);
  expect(undoneBundle.document).toEqual(beforeBundle.document);
  expect([...undoneBundle.embeddedDocuments]).toEqual([...beforeBundle.embeddedDocuments]);
  await expectEx18AssemblyPart(undone, EX18_B8, info, 'e-update-one-undo');
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  const finalPath = info.outputPath('ex18-B-e-update-redone.pcada');
  const redone = new Uint8Array(await saveFlowFile(page, finalPath, app));
  await expectEx18AssemblyPart(redone, movedExpected, info, 'e-update-one-redo');
  await openSaveFlowFile(page, finalPath, app);
  const reopened = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-B-e-assembly-reopened.pcada'), app));
  const redoneBundle = await ex18ReadAssembly(redone), reopenedBundle = await ex18ReadAssembly(reopened);
  expect(reopenedBundle.document).toEqual(redoneBundle.document);
  expect([...reopenedBundle.embeddedDocuments]).toEqual([...redoneBundle.embeddedDocuments]);
  await expectEx18AssemblyPart(reopened, movedExpected, info, 'e-assembly-reopened-real-hole');
}

export const EX18_B_HOLE_ROUTES = ['b', 'c', 'd', 'e'] as const;
export async function ex18BFlangeFlow(page: Page, info: TestInfo, entry: string,
  route: typeof EX18_B_HOLE_ROUTES[number], app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableFilePickers(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry); await waitForStartupHealth(page, info);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  if (route === 'b') await ruledFlange(page);
  else if (route === 'c') await stepFlange(page, info, app);
  else await cylinderFlange(page, route === 'd');
  await expectEx18Part(await saveFlangePart(page, info, route, 'blank', app), EX18_B_BLANK, info, `B-${route}-blank`);
  if (route === 'e') await referenceFlangePoint(page);
  else await plotPoints(page, [route === 'd' ? ['0*5', '0*5', '5+2*10'] : ['0', '0', '25']]);
  const before = await drillFlangeWithRefusalAndCancel(page, info, route, '点1', app);
  const saved = await flangeHoleContract(page, info, route, before, app);
  if (route === 'd') {
    const cylinders = ex18ReadPart(saved).document.solids.filter(feature => feature.kind === 'primitive');
    expect(cylinders).toMatchObject([
      { shape: { kind: 'cylinder', radius: { source: '3*5' }, height: { source: '10/2' } } },
      { shape: { kind: 'cylinder', radius: { source: '20/2' }, height: { source: '2*10' } } },
    ]);
  }
  if (route === 'e') await flangeContextContract(page, info, saved, app);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  expect(errors).toEqual([]);
}

async function stepFlange(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await cylinderFlange(page, false, '15');
  await solidRow(page, '和1').click();
  const authoredSeed = await saveFlangePart(page, info, 'c', 'authored-seed20', app);
  await expectEx18Part(authoredSeed, EX18_B_BLANK20, info, 'c-authored-seed20');
  const stepPath = info.outputPath('ex18-B-c-blank20.step');
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '書き出す');
  const panel = page.locator('.pcad-exchange');
  await panel.getByRole('radio', { name: 'STEP', exact: true }).click();
  if (app !== undefined) await saveTarget(app, stepPath);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await panel.getByRole('button', { name: '書き出す', exact: true }).click();
  if (download !== undefined) await (await download).saveAs(stepPath); else await diskFile(stepPath);
  await expect(panel).toHaveCount(0);
  const stepBytes = new Uint8Array(await readFile(stepPath));
  expect(new TextDecoder().decode(stepBytes.subarray(0, 15))).toContain('ISO-10303-21');
  const exportedSha = ex18BytesSha(stepBytes);
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
  if (app !== undefined) await openTarget(app, stepPath);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '読み込む');
  const token = await beginRecompute(page);
  await page.getByRole('form', { name: '読み込み', exact: true })
    .getByRole('button', { name: 'ファイルを選ぶ', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(stepPath);
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  const importedSeed = await saveFlangePart(page, info, 'c', 'imported-seed20', app);
  await expectEx18Part(importedSeed, EX18_B_BLANK20, info, 'c-imported-seed20');
  const imported = ex18ReadPart(importedSeed).document.solids.find(feature => feature.kind === 'importedSolid');
  if (imported?.kind !== 'importedSolid') throw new Error('EX18 ordinary STEP import did not create an imported body');
  expect(imported.source.format).toBe('step');
  expect(imported.source.fileName).toBe('ex18-B-c-blank20.step');
  expect(ex18BytesSha(new Uint8Array(await readFile(stepPath)))).toBe(exportedSha);
  await info.attach('ex18-c-actual-step-input', { path: stepPath, contentType: 'application/step' });
  await info.attach('ex18-c-step-identity', { body: JSON.stringify({ exportedSha, importedId: imported.id,
    source: imported.source, seedDocumentId: ex18ReadPart(authoredSeed).document.id,
    importedDocumentId: ex18ReadPart(importedSeed).document.id }), contentType: 'application/json' });
  await sketchTool(page, '選択').click();
  await page.locator('canvas.pcad-viewport__canvas').press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [5, 0, 20]);
  await chooseToolMenuItem(page, '加工', '面の移動');
  await expect(popoverTitle(page)).toHaveText('面を動かす');
  await fillFields(page, ['5']);
  const edit = await beginRecompute(page);
  await commitPopover(page); await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, edit);
  await expect(solidRow(page, '面の移動1')).toBeVisible();
}


async function faceThroughNamedPoints(page: Page, names: readonly string[]): Promise<void> {
  await sketchTool(page, '選択').click(); await waitForSettledRecompute(page);
  await treeRow(page, names[0]).click();
  for (const name of names.slice(1)) await treeRow(page, name).click({ modifiers: ['Shift'] });
  await page.locator('canvas.pcad-viewport__canvas').press('Shift+F10');
  const command = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true })
    .locator('[data-command-id="sketch.faceFromPoints"]');
  await expect(command).not.toHaveAttribute('aria-disabled', 'true');
  const token = await beginRecompute(page); await command.click(); await waitForRecompute(page, token);
}

/** A trusted middle-button orbit exposes C's +Y end face, hidden in the home view. */
async function selectObliquePositiveYFace(page: Page, rotate = true): Promise<void> {
  await sketchTool(page, '選択').click();
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  await canvas.press('3'); await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('EX18 C/c viewport is missing');
  const start = [box.x + box.width * 0.7, box.y + box.height * 0.5] as const;
  if (rotate) {
    const before = await readViewportRenderStats(page);
    await page.mouse.move(...start); await page.mouse.down({ button: 'middle' });
    try { await page.mouse.move(start[0] - 200, start[1], { steps: 8 }); }
    finally { await page.mouse.up({ button: 'middle' }); }
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders).toBeGreaterThan(before.completedRenders);
  }
  // cameraMath.ts: integer deltaX=-200, azimuth -= deltaX*0.008; unchanged home target/distance/elevation.
  const azimuth = -Math.PI / 4 + 200 * 0.008, elevation = Math.atan(Math.SQRT1_2);
  const z: WorldPoint = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
  const x: WorldPoint = [-Math.sin(azimuth), Math.cos(azimuth), 0];
  const y: WorldPoint = [-Math.sin(elevation) * Math.cos(azimuth), -Math.sin(elevation) * Math.sin(azimuth), Math.cos(elevation)];
  const point: WorldPoint = [12, 3, 5], view = point.map((value, index) => value - 200 * z[index]);
  const dot = (axis: WorldPoint): number => view.reduce((sum, value, index) => sum + value * axis[index], 0);
  const depth = -dot(z), scale = 1 / Math.tan(25 * Math.PI / 180);
  const ndcX = scale * dot(x) / (depth * (box.width / box.height)), ndcY = scale * dot(y) / depth;
  await page.mouse.click(box.x + (ndcX + 1) * box.width / 2, box.y + (1 - ndcY) * box.height / 2);
}

export async function ex18CStepFlow(page: Page, info: TestInfo, entry: string,
  app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableFilePickers(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry); await waitForStartupHealth(page, info);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await choosePlaneMenuItem(page, 'XZ');
  await plotPoints(page, [['0', '0', '0'], ['20', '0', '0'], ['25', '0', '10'], ['5', '0', '10']]);
  await faceThroughNamedPoints(page, ['点1', '点2', '点3', '点4']);
  await treeRow(page, '面1').click(); await chooseToolMenuItem(page, '作る', '押し出し');
  await expect(popoverTitle(page)).toHaveText('押し出す'); await fillFields(page, ['3']);
  await popover(page).getByRole('switch', { name: '向きを反転', exact: true }).click();
  let token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
  await expect(popover(page)).toHaveCount(0); await solidRow(page, '押し出し1').click();
  const save = async (stage: string): Promise<Uint8Array> => {
    await waitForSettledRecompute(page);
    return new Uint8Array(await saveFlowFile(page, info.outputPath(`ex18-C-c-${stage}.pcad`), app));
  };
  const seed = await save('authored-seed3'); await expectEx18Part(seed, EX18_C3, info, 'C-c-authored-seed3');
  const stepPath = info.outputPath('ex18-C-c-depth3.step');
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '書き出す');
  const panel = page.locator('.pcad-exchange');
  await panel.getByRole('radio', { name: 'STEP', exact: true }).click();
  if (app !== undefined) await saveTarget(app, stepPath);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await panel.getByRole('button', { name: '書き出す', exact: true }).click();
  if (download !== undefined) await (await download).saveAs(stepPath); else await diskFile(stepPath);
  await expect(panel).toHaveCount(0);
  const stepBytes = new Uint8Array(await readFile(stepPath)), stepSha = ex18BytesSha(stepBytes);
  expect(new TextDecoder().decode(stepBytes.subarray(0, 15))).toContain('ISO-10303-21');
  await fileAction(page, '新規').click(); await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
  if (app !== undefined) await openTarget(app, stepPath);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '読み込む'); token = await beginRecompute(page);
  await page.getByRole('form', { name: '読み込み', exact: true }).getByRole('button', { name: 'ファイルを選ぶ', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(stepPath);
  await waitForRecompute(page, token);
  const imported = await save('imported-seed3'), before = ex18ReadPart(imported).document;
  await expectEx18Part(imported, EX18_C3, info, 'C-c-imported-seed3');
  expect(before.solids).toMatchObject([{ kind: 'importedSolid', source: { format: 'step', fileName: 'ex18-C-c-depth3.step' } }]);
  expect(ex18BytesSha(new Uint8Array(await readFile(stepPath)))).toBe(stepSha);
  await info.attach('ex18-C-c-actual-step-input', { path: stepPath, contentType: 'application/step' });
  await info.attach('ex18-C-c-step-identity', { body: JSON.stringify({ stepSha, source: before.solids[0],
    seedDocumentId: ex18ReadPart(seed).document.id, importedDocumentId: before.id }), contentType: 'application/json' });
  await selectObliquePositiveYFace(page);
  await chooseToolMenuItem(page, '加工', '面の移動'); await expect(popoverTitle(page)).toHaveText('面を動かす');
  await fillFields(page, ['0']); await commitPopover(page);
  await expect(popover(page).getByRole('alert')).toHaveText('面を動かす距離は 0 でない数で指定してください。');
  await expect(solidRow(page, '面の移動1')).toHaveCount(0); await cancelPopover(page);
  expect(ex18ReadPart(await save('zero-refused-cancelled')).document).toEqual(before);
  await selectObliquePositiveYFace(page, false);
  await chooseToolMenuItem(page, '加工', '面の移動'); await expect(popoverTitle(page)).toHaveText('面を動かす');
  await fillFields(page, ['7']); token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  const initial = await save('depth10'), original = ex18ReadPart(initial).document;
  expect(original.solids).toMatchObject([{ kind: 'importedSolid' }, { kind: 'faceOffset', offset: { source: '7' } }]);
  await expectEx18Part(initial, EX18_C10, info, 'C-c-depth10');
  await sketchTool(page, '選択').click();
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token); const creationUndone = await save('creation-one-undo3');
  expect(ex18ReadPart(creationUndone).document).toEqual(before);
  await expectEx18Part(creationUndone, EX18_C3, info, 'C-c-creation-one-undo3');
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token); expect(ex18ReadPart(await save('creation-one-redo10')).document).toEqual(original);
  await solidRow(page, '面の移動1').click();
  const offsetLabel = uiMessage('propertyPanel', 'propertyPanel.faceOffsetDistance');
  await expect(propertyField(page, offsetLabel)).toHaveCount(1);
  await expect(propertyField(page, offsetLabel)).toHaveValue('7');
  await setExpression(page, '面の移動1', offsetLabel, '2');
  const edited = await save('depth5'), editedDocument = ex18ReadPart(edited).document;
  expect(editedDocument.solids.map(feature => feature.id)).toEqual(original.solids.map(feature => feature.id));
  expect(editedDocument.solids[1]).toMatchObject({ kind: 'faceOffset', offset: { source: '2' } });
  await expectEx18Part(edited, EX18_C5, info, 'C-c-depth5'); await sketchTool(page, '選択').click();
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token); const undone = await save('one-undo10');
  expect(ex18ReadPart(undone).document).toEqual(original); await expectEx18Part(undone, EX18_C10, info, 'C-c-one-undo10');
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token); const redone = await save('one-redo5');
  expect(ex18ReadPart(redone).document).toEqual(editedDocument); await expectEx18Part(redone, EX18_C5, info, 'C-c-one-redo5');
  await fileAction(page, '新規').click(); await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
  await openSaveFlowFile(page, info.outputPath('ex18-C-c-one-redo5.pcad'), app);
  const reopened = await save('reopened5'); expect(ex18ReadPart(reopened).document).toEqual(editedDocument);
  await expectEx18Part(reopened, EX18_C5, info, 'C-c-reopened5');
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0); expect(errors).toEqual([]);
}

async function createDepthParameter(page: Page, expression: string): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await propertyPanel(page).getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = propertyPanel(page).locator('.pcad-parameter').last();
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('奥行'); await name.press('Enter');
  const source = row.locator('.pcad-field').nth(1).locator('input');
  await source.fill(expression); await source.press('Enter');
  await row.getByRole('group', { name: '単位', exact: true }).getByRole('button', { name: 'mm', exact: true }).click();
  await waitForSettledRecompute(page); await expect(source).toHaveValue(expression);
  await page.getByRole('tab', { name: 'プロパティ', exact: true }).click();
}
async function editDepthParameter(page: Page, expression: string): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  const row = propertyPanel(page).locator('.pcad-parameter');
  // This case authors exactly one parameter; assert that identity before editing its source.
  await expect(row).toHaveCount(1);
  await expect(row.locator('.pcad-field').first().locator('input')).toHaveValue('奥行');
  const source = row.locator('.pcad-field').nth(1).locator('input');
  const token = await beginRecompute(page); await source.fill(expression); await source.press('Enter');
  await waitForRecompute(page, token); await expect(source).toHaveValue(expression);
  await page.getByRole('tab', { name: 'プロパティ', exact: true }).click();
}

export const EX18_C_BASIC_ROUTES = ['a', 'b', 'd', 'e'] as const;
export async function ex18CObliqueFlow(page: Page, info: TestInfo, entry: string,
  route: typeof EX18_C_BASIC_ROUTES[number], app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableFilePickers(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry); await waitForStartupHealth(page, info);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  if (route === 'a') {
    await choosePlaneMenuItem(page, 'XZ');
    await plotPoints(page, [['0', '0', '0'], ['20', '0', '0'], ['25', '0', '10'], ['5', '0', '10']]);
    await faceThroughNamedPoints(page, ['点1', '点2', '点3', '点4']);
  } else {
    // One public parameter commits all four dependent Y coordinates atomically.
    await createDepthParameter(page, route === 'd' ? '2*5' : '10');
    await choosePlaneMenuItem(page, '3D');
    if (route === 'e') await relativeObliquePoints(page);
    else await plotPoints(page, route === 'd' ? [
      ['0', '0', '0'], ['4*5', '0', '0'], ['4*5', '奥行', '0'], ['0', '奥行', '0'],
      ['0+5', '0', '2*5'], ['4*5+5', '0', '2*5'], ['4*5+5', '奥行', '2*5'], ['0+5', '奥行', '2*5'],
    ] : [
      ['0', '0', '0'], ['20', '0', '0'], ['20', '奥行', '0'], ['0', '奥行', '0'],
      ['5', '0', '10'], ['25', '0', '10'], ['25', '奥行', '10'], ['5', '奥行', '10'],
    ]);
    for (const loop of FACE_LOOPS) await faceThroughNamedPoints(page, loop.map(point => `点${String(point)}`));
  }
  const save = async (stage: string): Promise<Uint8Array> => {
    await waitForSettledRecompute(page);
    return new Uint8Array(await saveFlowFile(page, info.outputPath(`ex18-C-${route}-${stage}.pcad`), app));
  };
  const before = ex18ReadPart(await save('before-solid')).document;
  const begin = async (): Promise<void> => {
    await sketchTool(page, '選択').click(); await treeRow(page, '面1').click();
    if (route !== 'a') {
      for (let index = 2; index <= 6; index++) await treeRow(page, `面${String(index)}`).click({ modifiers: ['Shift'] });
    }
    await chooseToolMenuItem(page, '作る', route === 'a' ? '押し出し' : '縫合');
    await expect(popoverTitle(page)).toHaveText(route === 'a' ? '押し出す' : 'つなぐ');
    if (route === 'a') {
      const reverse = popover(page).getByRole('switch', { name: '向きを反転', exact: true });
      await expect(reverse).toHaveAttribute('aria-checked', 'false'); await reverse.click();
    }
  };
  const solidName = route === 'a' ? '押し出し1' : '縫合1';
  await begin(); await fillFields(page, ['0']); await commitPopover(page);
  await expect(popoverInputs(page).first()).toHaveAttribute('aria-invalid', 'true');
  await expect(popover(page).locator('.pcad-field__message--error').first()).toBeVisible();
  await expect(popover(page).locator('.pcad-field__message--error').first()).not.toBeEmpty();
  await expect(solidRow(page, solidName)).toHaveCount(0); await cancelPopover(page);
  expect(ex18ReadPart(await save('refused-cancelled')).document).toEqual(before);
  await begin(); await fillFields(page, [route === 'a' ? '10' : '0.01']);
  let token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  await expect(solidRow(page, solidName)).toBeVisible();
  const initial = await save('depth10'), original = ex18ReadPart(initial).document;
  expect(original.solids.map(feature => feature.kind)).toEqual([route === 'a' ? 'extrude' : 'sew']);
  await expectEx18Part(initial, EX18_C10, info, `C-${route}-depth10`);
  await sketchTool(page, '選択').click();
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  expect(ex18ReadPart(await save('creation-one-undo')).document).toEqual(before);
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  expect(ex18ReadPart(await save('creation-one-redo')).document).toEqual(original);
  if (route === 'a') {
    await solidRow(page, solidName).click(); await setExpression(page, solidName, '距離', '5');
  } else await editDepthParameter(page, route === 'd' ? '10/2' : '5');
  const edited = await save('depth5'), editedDocument = ex18ReadPart(edited).document;
  expect(editedDocument.id).toBe(original.id);
  expect(editedDocument.solids.map(feature => feature.id)).toEqual(original.solids.map(feature => feature.id));
  expect(editedDocument.sketches[0].features.map(feature => feature.id))
    .toEqual(original.sketches[0].features.map(feature => feature.id));
  if (route === 'a') expect(editedDocument.solids[0]).toMatchObject({ kind: 'extrude', distance: { source: '5' } });
  else expect(editedDocument.parameters).toMatchObject([{ name: '奥行', value: { source: route === 'd' ? '10/2' : '5' } }]);
  if (route === 'd') expect(editedDocument.sketches[0].features.find(feature => feature.name === '点7'))
    .toMatchObject({ kind: 'point', planeId: 'free', at: { x: { source: '4*5+5' }, y: { source: '奥行' }, z: { source: '2*5' } } });
  await expectEx18Part(edited, EX18_C5, info, `C-${route}-depth5`);
  await sketchTool(page, '選択').click();
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const undone = await save('one-undo10'); expect(ex18ReadPart(undone).document).toEqual(original);
  await expectEx18Part(undone, EX18_C10, info, `C-${route}-one-undo10`);
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  const redone = await save('one-redo5'); expect(ex18ReadPart(redone).document).toEqual(editedDocument);
  await expectEx18Part(redone, EX18_C5, info, `C-${route}-one-redo5`);
  await fileAction(page, '新規').click(); await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
  await openSaveFlowFile(page, info.outputPath(`ex18-C-${route}-one-redo5.pcad`), app);
  const reopened = await save('reopened5'); expect(ex18ReadPart(reopened).document).toEqual(editedDocument);
  await expectEx18Part(reopened, EX18_C5, info, `C-${route}-reopened5`);
  if (route === 'e') await obliqueContextContract(page, info, reopened, app);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  expect(errors).toEqual([]);
}

async function relativeObliquePoints(page: Page): Promise<void> {
  await referenceObliquePoint(page);
  await sketchTool(page, '点').click(); await expect(popoverTitle(page)).toHaveText('点を作る');
  await popover(page).getByRole('group', { name: '位置の決め方', exact: true })
    .getByRole('button', { name: '相対', exact: true }).click();
  for (const delta of [['20', '0', '0'], ['0', '奥行', '0'], ['-20', '0', '0'],
    ['5', '-奥行', '10'], ['20', '0', '0'], ['0', '奥行', '0'], ['-20', '0', '0']]) {
    await fillFields(page, delta); await commitPopover(page);
  }
  await cancelPopover(page); await waitForSettledRecompute(page);
}
async function saveObliqueReferencePart(page: Page, info: TestInfo, route: Ex18ARoute, stage: string,
  app?: ElectronApplication): Promise<Uint8Array> {
  await waitForSettledRecompute(page);
  return new Uint8Array(await saveFlowFile(page, info.outputPath(`ex18-C-${route}-${stage}.pcad`), app));
}

async function referenceObliquePoint(page: Page): Promise<string> {
  await choosePlaneMenuItem(page, '基準点');
  await expect(popoverTitle(page)).toHaveText('基準点の決め方');
  await commitReference(page);
  await expect(popoverTitle(page)).toHaveText('基準点の位置');
  await fillFields(page, ['0', '0', '0']); await commitReference(page);
  if (await popover(page).count() > 0) await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await expect(sketchTool(page, '選択')).toHaveAttribute('aria-pressed', 'true');
  await waitForSettledRecompute(page);
  const referenceSection = page.locator('.pcad-tree__sections > li').filter({ hasText: '基準' });
  const reference = referenceSection.getByRole('button', { name: '基準点1', exact: true });
  await expect(reference).toHaveCount(1);
  await expect(reference).toBeVisible(); await reference.click();
  await page.locator('canvas.pcad-viewport__canvas').press('Shift+F10');
  const command = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true })
    .locator('[data-command-id="sketch.pointAtReference"]');
  await expect(command).not.toHaveAttribute('aria-disabled', 'true');
  const token = await beginRecompute(page); await command.click(); await waitForRecompute(page, token);
  await expect(treeRow(page, '点1')).toBeVisible();
  return '点1';
}

async function obliqueContextContract(page: Page, info: TestInfo, bracket: Uint8Array, app?: ElectronApplication): Promise<void> {
  const reference = ex18ReadPart(bracket).document.references.find(feature => feature.kind === 'referencePoint');
  if (reference?.kind !== 'referencePoint') throw new Error('EX18 UI reference point missing');
  await fileAction(page, '新規').click();
  await chooseToolMenuItem(page, '作る', '球');
  await expect(popoverTitle(page)).toHaveText('球を置く'); await fillFields(page, ['2']);
  let token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
  if (await popover(page).count() > 0) await cancelPopover(page);
  const sphere = await saveObliqueReferencePart(page, info, 'e', 'source-sphere', app);
  token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [
    { fileName: 'ex18-authored-C.pcad', bytes: bracket }, { fileName: 'ex18-authored-sphere.pcad', bytes: sphere },
  ] });
  try {
    await placeQueuedPart(page, ['0', '0', '0']); await placeQueuedPart(page, ['0', '0', '0']);
  } finally { await resetAssemblyFileGateway(page); }
  await selectComponent(page, 0);
  const form = page.getByTestId('assembly-context-form'); await expect(form).toBeVisible();
  await page.getByTestId('assembly-context-point').selectOption({ label: reference.name });
  await expect(page.getByTestId('assembly-context-face').locator('option')).toHaveCount(2);
  await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
  token = await beginRecompute(page);
  await form.getByRole('button', { name: '参照を作る', exact: true }).click(); await waitForRecompute(page, token);
  await expect(form.getByRole('alert')).toHaveCount(0);
  const linkedPath = info.outputPath('ex18-C-e-linked.pcada');
  const linked = new Uint8Array(await saveFlowFile(page, linkedPath, app));
  const linkedState = await expectEx18AssemblyPart(linked, EX18_C5, info, 'e-linked-depth5');
  expect(linkedState.document.contextReferences).toHaveLength(1);
  // Move the real source component; its placement is an independent input to the reference resolver.
  await dragContextSource(page, [0, 0, 0]);
  const sourcePosition = (await readAssemblyStats(page)).components[1]?.resolved?.position;
  if (sourcePosition === undefined || sourcePosition.length !== 3) throw new Error('EX18 moved source pose missing');
  expect(Math.abs(sourcePosition[0] - 0)).toBeGreaterThan(0.5);
  const beforeUpdate = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-C-e-before-update.pcada'), app));
  await expectEx18AssemblyPart(beforeUpdate, EX18_C5, info, 'e-manual-update-not-automatic');
  await selectComponent(page, 0); token = await beginRecompute(page);
  await page.getByTestId('assembly-context-update').click(); await waitForRecompute(page, token);
  const updated = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-C-e-updated.pcada'), app));
  const movedExpected = { ...EX18_C5,
    low: [sourcePosition[0], sourcePosition[1], sourcePosition[2]] as const,
    high: [sourcePosition[0] + 25, sourcePosition[1] + 5, sourcePosition[2] + 10] as const };
  const updatedState = await expectEx18AssemblyPart(updated, movedExpected, info, 'e-updated-real-prism');
  expect(updatedState.document.contextReferences?.map(link => link.id))
    .toEqual(linkedState.document.contextReferences?.map(link => link.id));
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const undone = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-C-e-update-undone.pcada'), app));
  const beforeBundle = await ex18ReadAssembly(beforeUpdate), undoneBundle = await ex18ReadAssembly(undone);
  expect(undoneBundle.document).toEqual(beforeBundle.document);
  expect([...undoneBundle.embeddedDocuments]).toEqual([...beforeBundle.embeddedDocuments]);
  await expectEx18AssemblyPart(undone, EX18_C5, info, 'e-update-one-undo');
  token = await beginRecompute(page); await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  const finalPath = info.outputPath('ex18-C-e-update-redone.pcada');
  const redone = new Uint8Array(await saveFlowFile(page, finalPath, app));
  await expectEx18AssemblyPart(redone, movedExpected, info, 'e-update-one-redo');
  await openSaveFlowFile(page, finalPath, app);
  const reopened = new Uint8Array(await saveFlowFile(page, info.outputPath('ex18-C-e-assembly-reopened.pcada'), app));
  const redoneBundle = await ex18ReadAssembly(redone), reopenedBundle = await ex18ReadAssembly(reopened);
  expect(reopenedBundle.document).toEqual(redoneBundle.document);
  expect([...reopenedBundle.embeddedDocuments]).toEqual([...redoneBundle.embeddedDocuments]);
  await expectEx18AssemblyPart(reopened, movedExpected, info, 'e-assembly-reopened-real-prism');
}


/** A projected point may hit a different body; prove the real source hover before any drag. */
async function dragContextSource(page: Page, center: WorldPoint): Promise<void> {
  await goHome(page);
  await page.locator('canvas.pcad-viewport__canvas').press('4');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');
  await expect(componentRows(page)).toHaveCount(2);
  const source = componentRows(page).nth(1);
  const from = await homeViewPagePoint(page, center);
  const to = await homeViewPagePoint(page, [center[0] + 2, center[1], center[2]]);
  await page.mouse.move(...from);
  await expect(source.locator('xpath=..')).toHaveClass(/pcad-tree__row--hovered/u);
  const token = await beginRecompute(page);
  await page.mouse.down();
  try { await page.mouse.move(to[0], to[1], { steps: 8 }); }
  finally { await page.mouse.up(); }
  await waitForRecompute(page, token);
}
