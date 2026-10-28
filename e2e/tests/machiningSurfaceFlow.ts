import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { PartDocument } from '../../packages/model/src/part/types.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { cancelPopover, clickWorldPoint, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace,
  popover, popoverInputs, popoverTitle, propertyPanel, selectionKindLabel, sketchTool, topFaceCenter, treeRow } from './solidCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';
import { ex18ReadPart } from './ex18RoutesOracle.js';
import { expectMachiningPart, PLANE_BLANK, PLANE_HOLE6, PLANE_HOLE8, editedSurfaceExpected, expectSurfaceMachining, surfaceExpected,
  createTwoLocationFixture, expectTwoLocationMachining, type TwoLocationOperation,
  type SurfaceMachiningCase, type SurfaceMachiningExpected } from './machiningSurfaceOracle.js';

export const MACHINING_WEB_TITLE = 'EX-05.UI Web plane/plain-through: UI edit, zero refusal/cancel, one Undo/Redo, fresh-page PCAD native';
export const MACHINING_ELECTRON_TITLE = 'EX-05.UI Electron plane/plain-through: UI edit, zero refusal/cancel, one Undo/Redo, fresh-process PCAD native';
export interface SavedMachiningScenario { readonly path: string; readonly document: PartDocument }

export function solidRow(page: Page, name: string): Locator {
  return page.locator('.pcad-tree__sections > li').filter({ hasText: uiMessage('toolbar', 'toolbar.solid.title') })
    .getByRole('button', { name, exact: true });
}
export function field(page: Page, container: Locator, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return container.locator('.pcad-field').filter({ has: page.locator('.pcad-field__label',
    { hasText: new RegExp(`^${escaped}$`, 'u') }) }).locator('input.pcad-field__input');
}
export async function fillUnique(input: Locator, current: string, next: string): Promise<void> {
  await expect(input).toHaveCount(1); await expect(input).toHaveValue(current);
  await input.fill(next); await expect(input).toHaveValue(next);
}
export async function save(page: Page, info: TestInfo, label: string, app?: ElectronApplication) {
  await waitForSettledRecompute(page);
  const path = info.outputPath(`machining-plane-${label}.pcad`);
  return { path, bytes: new Uint8Array(await saveFlowFile(page, path, app)) };
}
export async function prepare(page: Page, info: TestInfo, entry: string): Promise<void> {
  await disableFilePickers(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry); await waitForStartupHealth(page, info);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
}
async function beginHole(page: Page, stockName: string): Promise<void> {
  const stock = solidRow(page, stockName);
  await expect(stock).toHaveCount(1); await stock.click();
  await expect(stock).toHaveAttribute('aria-pressed', 'true');
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.select')).click();
  await page.locator('canvas.pcad-viewport__canvas').press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, topFaceCenter(10));
  await expect(treeRow(page, '点1')).toHaveCount(1);
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '加工', uiMessage('toolbar', 'toolbar.machining.hole'));
  await expect(popover(page)).toHaveCount(1);
  await expect(popoverTitle(page)).toHaveText(uiMessage('numericInput', 'numericInput.title.hole'));
  await expect(field(page, popover(page), uiMessage('numericInput', 'numericInput.field.diameter'))).toHaveValue('6');
}
async function undoRedo(page: Page, before: PartDocument, after: PartDocument,
  info: TestInfo, label: string, app?: ElectronApplication): Promise<void> {
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.select')).click();
  let token = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await waitForRecompute(page, token);
  const undone = await save(page, info, `${label}-undo`, app);
  expect(ex18ReadPart(undone.bytes).document).toEqual(before);
  await expectMachiningPart(undone.bytes, label === 'cancel-history' ? PLANE_BLANK : PLANE_HOLE6, info, `${label}-undo`);
  token = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+y');
  await waitForRecompute(page, token);
  const redone = await save(page, info, `${label}-redo`, app);
  expect(ex18ReadPart(redone.bytes).document).toEqual(after);
  await expectMachiningPart(redone.bytes, label === 'cancel-history' ? PLANE_BLANK : PLANE_HOLE8, info, `${label}-redo`);
}

export async function buildPlanarMachining(page: Page, info: TestInfo, entry: string,
  app?: ElectronApplication): Promise<SavedMachiningScenario> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page, info, entry);
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '10'); await waitForSettledRecompute(page);
  const seed = await save(page, info, 'seed', app), seedDocument = ex18ReadPart(seed.bytes).document;
  const stock = seedDocument.solids.find(feature => feature.kind === 'extrude');
  if (stock === undefined) throw new Error('UI extrusion missing');
  await expectMachiningPart(seed.bytes, PLANE_BLANK, info, 'seed');
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.point')).click();
  await expect(popoverTitle(page)).toHaveText(uiMessage('numericInput', 'numericInput.title.point'));
  await expect(popoverInputs(page)).toHaveCount(3);
  await fillFields(page, ['10', '15', '0']); await commitPopover(page); await cancelPopover(page);
  const ready = await save(page, info, 'ready', app), before = ex18ReadPart(ready.bytes).document;
  const baseline = await expectMachiningPart(ready.bytes, PLANE_BLANK, info, 'ready');
  await beginHole(page, stock.name);
  const diameter = field(page, popover(page), uiMessage('numericInput', 'numericInput.field.diameter'));
  await fillUnique(diameter, '6', '0'); await commitPopover(page);
  await expect(popover(page)).toBeVisible(); await expect(diameter).toHaveAttribute('aria-invalid', 'true');
  await expect(popover(page).locator('.pcad-field__message--error').first()).not.toBeEmpty();
  await cancelPopover(page);
  const refused = await save(page, info, 'refused', app);
  expect(ex18ReadPart(refused.bytes).document).toEqual(before);
  const refusalNative = await expectMachiningPart(refused.bytes, PLANE_BLANK, info, 'refused');
  expect(refusalNative.shapeSha).toBe(baseline.shapeSha); expect(refusalNative.brepSha).toBe(baseline.brepSha);
  await beginHole(page, stock.name);
  await fillUnique(field(page, popover(page), uiMessage('numericInput', 'numericInput.field.diameter')), '6', '8');
  await cancelPopover(page);
  const cancelled = await save(page, info, 'cancelled', app);
  expect(ex18ReadPart(cancelled.bytes).document).toEqual(before);
  const cancelNative = await expectMachiningPart(cancelled.bytes, PLANE_BLANK, info, 'cancelled');
  expect(cancelNative.shapeSha).toBe(baseline.shapeSha); expect(cancelNative.brepSha).toBe(baseline.brepSha);
  // One ordinary Undo must remove the point, never an invisible refused/cancelled transaction.
  await undoRedo(page, seedDocument, before, info, 'cancel-history', app);
  await beginHole(page, stock.name);
  const through = popover(page).getByRole('switch', { name: uiMessage('numericInput', 'numericInput.toggle.through'), exact: true });
  await expect(through).toHaveCount(1); await expect(through).toHaveAttribute('aria-checked', 'false');
  await through.click(); await expect(through).toHaveAttribute('aria-checked', 'true');
  let token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  const original = await save(page, info, 'diameter6', app), originalDocument = ex18ReadPart(original.bytes).document;
  const hole = originalDocument.solids.find(feature => feature.kind === 'hole');
  if (hole?.kind !== 'hole') throw new Error('UI hole missing');
  expect(hole.targetFeatureId).toBe(stock.id);
  await expectMachiningPart(original.bytes, PLANE_HOLE6, info, 'diameter6');
  await expect(solidRow(page, hole.name)).toHaveCount(1); await solidRow(page, hole.name).click();
  const property = field(page, propertyPanel(page), uiMessage('propertyPanel', 'propertyPanel.diameter'));
  token = await beginRecompute(page); await fillUnique(property, '6', '8'); await solidRow(page, hole.name).click();
  await waitForRecompute(page, token); await expect(property).toHaveValue('8');
  const edited = await save(page, info, 'diameter8', app), editedDocument = ex18ReadPart(edited.bytes).document;
  expect(editedDocument.id).toBe(originalDocument.id);
  expect(editedDocument.solids.map(feature => feature.id)).toEqual(originalDocument.solids.map(feature => feature.id));
  const editedHole = editedDocument.solids.find(feature => feature.id === hole.id);
  if (editedHole?.kind !== 'hole') throw new Error('Edited hole identity missing');
  expect(editedHole.face).toEqual(hole.face); expect(editedHole.diameter.source).toBe('8');
  await expectMachiningPart(edited.bytes, PLANE_HOLE8, info, 'diameter8');
  await undoRedo(page, originalDocument, editedDocument, info, 'diameter-edit', app);
  const final = await save(page, info, 'final', app);
  expect(ex18ReadPart(final.bytes).document).toEqual(editedDocument);
  expect(errors).toEqual([]);
  return { path: final.path, document: editedDocument };
}

export async function reopenPlanarMachining(page: Page, info: TestInfo, entry: string,
  saved: SavedMachiningScenario, app?: ElectronApplication): Promise<void> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page, info, entry); await openSaveFlowFile(page, saved.path, app);
  const hole = saved.document.solids.find(feature => feature.kind === 'hole');
  if (hole === undefined) throw new Error('Saved machining identity missing');
  await expect(solidRow(page, hole.name)).toHaveCount(1); await solidRow(page, hole.name).click();
  await expect(field(page, propertyPanel(page), uiMessage('propertyPanel', 'propertyPanel.diameter'))).toHaveValue('8');
  const reopened = await save(page, info, 'fresh-reopened', app);
  expect(ex18ReadPart(reopened.bytes).document).toEqual(saved.document);
  await expectMachiningPart(reopened.bytes, PLANE_HOLE8, info, 'fresh-reopened');
  expect(errors).toEqual([]);
}

const SURFACES: readonly SurfaceMachiningCase['surface'][] = ['plane', 'cylinder'];
const OPERATIONS: readonly SurfaceMachiningCase['operation'][] = ['plain', 'thread', 'counterbore'];
export const ADDITIONAL_MACHINING_CASES: readonly SurfaceMachiningCase[] = SURFACES.flatMap(surface =>
  OPERATIONS.flatMap(operation => [false, true].map(through => ({ surface, operation, through }))))
  .filter(scenario => !(scenario.surface === 'plane' && scenario.operation === 'plain' && scenario.through));
export function machiningTitle(edition: 'Web' | 'Electron', scenario: SurfaceMachiningCase): string {
  return `EX-05.UI ${edition} ${scenario.surface}/${scenario.operation}-${scenario.through ? 'through' : 'blind'}: UI edit, zero refusal/cancel, one Undo/Redo, cold PCAD native`;
}
export interface SavedSurfaceMachining extends SavedMachiningScenario {
  readonly expected: SurfaceMachiningExpected;
  readonly editLabel: string;
  readonly editSource: string;
}
async function setNumeric(page: Page, key: string, source: string): Promise<void> {
  const input = field(page, popover(page), uiMessage('numericInput', `numericInput.field.${key}`));
  await expect(input).toHaveCount(1); await expect(input).toBeVisible();
  const current = await input.inputValue(); expect(current).not.toBe('');
  await fillUnique(input, current, source);
}
async function toggle(page: Page, key: string, checked: boolean): Promise<void> {
  const input = popover(page).getByRole('switch', { name: uiMessage('numericInput', `numericInput.toggle.${key}`), exact: true });
  await expect(input).toHaveCount(1);
  const current = await input.getAttribute('aria-checked'); expect(['false', 'true']).toContain(current);
  if (current !== String(checked)) await input.click();
  await expect(input).toHaveAttribute('aria-checked', String(checked));
}
async function beginSurfaceMachining(page: Page, stockName: string, scenario: SurfaceMachiningCase): Promise<void> {
  await expect(solidRow(page, stockName)).toHaveCount(1); await solidRow(page, stockName).click();
  await expect(solidRow(page, stockName)).toHaveAttribute('aria-pressed', 'true');
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.select')).click();
  await page.locator('canvas.pcad-viewport__canvas').press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  if (scenario.surface === 'plane') {
    await clickWorldPoint(page, topFaceCenter(10));
    await expect(treeRow(page, '点1')).toHaveCount(1); await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  } else {
    // Existing cylinderSubshapeColdFlow's visible outward side, not either end cap.
    await clickWorldPoint(page, [10 * Math.SQRT1_2, -10 * Math.SQRT1_2, 20]);
  }
  const thread = scenario.operation === 'thread';
  await chooseToolMenuItem(page, '加工', uiMessage('toolbar', thread ? 'toolbar.machining.threadHole' : 'toolbar.machining.hole'));
  await expect(popoverTitle(page)).toHaveText(uiMessage('numericInput', thread ? 'numericInput.title.threadHole' : 'numericInput.title.hole'));
  if (thread) {
    await expect(popover(page).locator('.pcad-menu__count')).toHaveText('M6');
    await toggle(page, 'modeledThread', false); await setNumeric(page, 'threadLength', '1');
  } else {
    await setNumeric(page, 'diameter', '4');
    if (scenario.operation === 'counterbore') {
      const group = popover(page).getByRole('group', { name: uiMessage('numericInput', 'numericInput.choice.holeEntry'), exact: true });
      const button = group.getByRole('button', { name: uiMessage('numericInput', 'numericInput.holeEntry.counterbore'), exact: true });
      await expect(button).toHaveCount(1); await button.click();
      await setNumeric(page, 'counterboreDiameter', '8'); await setNumeric(page, 'counterboreDepth', '2');
    }
  }
  if (scenario.surface === 'cylinder') {
    await toggle(page, 'cylinderFace', true);
    await setNumeric(page, 'holeCylinderHeight', '13'); await setNumeric(page, 'holeCylinderAngle', '-53');
  } else await toggle(page, 'cylinderFace', false);
  await toggle(page, 'through', scenario.through);
  if (!scenario.through) await setNumeric(page, 'depth', '4');
}
export async function pressHistory(page: Page, shortcut: 'Control+z' | 'Control+y'): Promise<void> {
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.select')).click();
  const token = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').press(shortcut); await waitForRecompute(page, token);
}
function surfaceEdit(original: SurfaceMachiningExpected): { label: string; before: string; after: string } {
  return original.surface === 'cylinder' ? { label: uiMessage('numericInput', 'numericInput.field.holeCylinderHeight'), before: '13', after: '17' }
    : !original.through ? { label: uiMessage('propertyPanel', 'propertyPanel.depth'), before: '4', after: '5' }
      : original.operation === 'thread' ? { label: uiMessage('propertyPanel', 'propertyPanel.threadLength'), before: '1', after: '2' }
        : { label: uiMessage('propertyPanel', 'propertyPanel.diameter'), before: '4', after: '6' };
}

export async function buildSurfaceMachining(page: Page, info: TestInfo, entry: string,
  scenario: SurfaceMachiningCase, app?: ElectronApplication): Promise<SavedSurfaceMachining> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page, info, entry);
  const expected = surfaceExpected(scenario), blank = { ...expected, blank: true };
  if (scenario.surface === 'plane') {
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['線分1', '線分2', '線分3', '線分4']); await extrudeFace(page, '面1', '10');
  } else {
    await chooseToolMenuItem(page, '作る', uiMessage('toolbar', 'toolbar.solid.cylinder'));
    await expect(popoverTitle(page)).toHaveText(uiMessage('numericInput', 'numericInput.title.cylinder'));
    await setNumeric(page, 'radius', '10'); await setNumeric(page, 'height', '40');
    const token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
    if (await popover(page).count() > 0) await cancelPopover(page);
  }
  await waitForSettledRecompute(page);
  const seed = await save(page, info, 'seed', app), seedDocument = ex18ReadPart(seed.bytes).document;
  expect(seedDocument.solids).toHaveLength(1);
  const stock = seedDocument.solids[0]; if (stock === undefined) throw new Error('Missing UI stock');
  await expectSurfaceMachining(seed.bytes, blank, info, 'seed');
  // This unused point is also a public, known history marker for the cylinder cancellation probe.
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.point')).click();
  await expect(popoverInputs(page)).toHaveCount(3); await fillFields(page, ['10', '15', '0']);
  await commitPopover(page); await cancelPopover(page);
  const ready = await save(page, info, 'ready', app), before = ex18ReadPart(ready.bytes).document;
  const nativeBefore = await expectSurfaceMachining(ready.bytes, blank, info, 'ready');
  await beginSurfaceMachining(page, stock.name, scenario);
  const invalidKey = scenario.operation === 'thread' ? 'threadLength' : 'diameter';
  await setNumeric(page, invalidKey, '0'); await commitPopover(page);
  const invalid = field(page, popover(page), uiMessage('numericInput', `numericInput.field.${invalidKey}`));
  await expect(invalid).toHaveAttribute('aria-invalid', 'true');
  await expect(popover(page).locator('.pcad-field__message--error').first()).not.toBeEmpty();
  await cancelPopover(page);
  const refused = await save(page, info, 'refused', app);
  expect(ex18ReadPart(refused.bytes).document).toEqual(before);
  const rejectedNative = await expectSurfaceMachining(refused.bytes, blank, info, 'refused');
  expect(rejectedNative.shapeSha).toBe(nativeBefore.shapeSha); expect(rejectedNative.brepSha).toBe(nativeBefore.brepSha);
  await beginSurfaceMachining(page, stock.name, scenario); await cancelPopover(page);
  const cancelled = await save(page, info, 'cancelled', app);
  expect(ex18ReadPart(cancelled.bytes).document).toEqual(before);
  const cancelledNative = await expectSurfaceMachining(cancelled.bytes, blank, info, 'cancelled');
  expect(cancelledNative.shapeSha).toBe(nativeBefore.shapeSha); expect(cancelledNative.brepSha).toBe(nativeBefore.brepSha);
  await pressHistory(page, 'Control+z');
  expect(ex18ReadPart((await save(page, info, 'cancel-one-undo', app)).bytes).document).toEqual(seedDocument);
  await pressHistory(page, 'Control+y');
  expect(ex18ReadPart((await save(page, info, 'cancel-one-redo', app)).bytes).document).toEqual(before);
  await beginSurfaceMachining(page, stock.name, scenario);
  let token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  const original = await save(page, info, 'machined', app), originalDocument = ex18ReadPart(original.bytes).document;
  const machining = originalDocument.solids.find(feature => feature.kind === 'hole' || feature.kind === 'threadHole');
  if (machining?.kind !== 'hole' && machining?.kind !== 'threadHole') throw new Error('Missing authored machining');
  expect(machining.targetFeatureId).toBe(stock.id);
  const nativeOriginal = await expectSurfaceMachining(original.bytes, expected, info, 'machined');
  await expect(solidRow(page, machining.name)).toHaveCount(1); await solidRow(page, machining.name).click();
  const edit = surfaceEdit(expected), input = field(page, propertyPanel(page), edit.label);
  token = await beginRecompute(page); await fillUnique(input, edit.before, edit.after); await solidRow(page, machining.name).click();
  await waitForRecompute(page, token); await expect(input).toHaveValue(edit.after);
  const finalExpected = editedSurfaceExpected(expected);
  const edited = await save(page, info, 'edited', app), editedDocument = ex18ReadPart(edited.bytes).document;
  expect(editedDocument.id).toBe(originalDocument.id);
  expect(editedDocument.solids.map(feature => feature.id)).toEqual(originalDocument.solids.map(feature => feature.id));
  const editedFeature = editedDocument.solids.find(feature => feature.id === machining.id);
  if (editedFeature?.kind !== 'hole' && editedFeature?.kind !== 'threadHole') throw new Error('Edited feature ID changed');
  expect(editedFeature.face).toEqual(machining.face);
  const nativeEdited = await expectSurfaceMachining(edited.bytes, finalExpected, info, 'edited');
  expect(nativeEdited.shapeSha).not.toBe(nativeOriginal.shapeSha);
  await pressHistory(page, 'Control+z');
  const undone = await save(page, info, 'edit-one-undo', app);
  expect(ex18ReadPart(undone.bytes).document).toEqual(originalDocument);
  const nativeUndone = await expectSurfaceMachining(undone.bytes, expected, info, 'edit-one-undo');
  expect(nativeUndone.shapeSha).toBe(nativeOriginal.shapeSha); expect(nativeUndone.brepSha).toBe(nativeOriginal.brepSha);
  await pressHistory(page, 'Control+y');
  const redone = await save(page, info, 'edit-one-redo', app);
  expect(ex18ReadPart(redone.bytes).document).toEqual(editedDocument);
  const nativeRedone = await expectSurfaceMachining(redone.bytes, finalExpected, info, 'edit-one-redo');
  expect(nativeRedone.shapeSha).toBe(nativeEdited.shapeSha); expect(nativeRedone.brepSha).toBe(nativeEdited.brepSha);
  expect(errors).toEqual([]);
  return { path: redone.path, document: editedDocument, expected: finalExpected, editLabel: edit.label, editSource: edit.after };
}
export async function reopenSurfaceMachining(page: Page, info: TestInfo, entry: string,
  saved: SavedSurfaceMachining, app?: ElectronApplication): Promise<void> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page, info, entry); await openSaveFlowFile(page, saved.path, app);
  const machining = saved.document.solids.find(feature => feature.kind === 'hole' || feature.kind === 'threadHole');
  if (machining === undefined) throw new Error('Missing saved machining identity');
  await expect(solidRow(page, machining.name)).toHaveCount(1); await solidRow(page, machining.name).click();
  await expect(field(page, propertyPanel(page), saved.editLabel)).toHaveValue(saved.editSource);
  const reopened = await save(page, info, 'fresh-reopened', app);
  expect(ex18ReadPart(reopened.bytes).document).toEqual(saved.document);
  await expectSurfaceMachining(reopened.bytes, saved.expected, info, 'fresh-reopened'); expect(errors).toEqual([]);
}

export function twoLocationTitle(edition: 'Web' | 'Electron', operation: TwoLocationOperation): string {
  return `EX-05.UI ${edition} cylinder/two-location-${operation}: fixture-open, position2 math/angle, selection/cancel zero, one Undo/Redo, cold PCAD native`;
}
export interface SavedTwoLocationMachining extends SavedMachiningScenario {
  readonly operation: TwoLocationOperation;
  readonly shapeSha: string;
  readonly brepSha: string;
}
function twoLocationFeature(document: PartDocument) {
  const feature = document.solids.find(item => item.id === 'two-location-machining');
  if ((feature?.kind !== 'hole' && feature?.kind !== 'threadHole') || feature.cylindrical?.locations.length !== 2) {
    throw new Error('Missing authored two-position machining');
  }
  return feature;
}
function locationField(page: Page, member: 'Height' | 'Angle'): Locator {
  return field(page, propertyPanel(page), uiMessage('numericInput', `numericInput.field.holeCylinder${member}`));
}
export async function selectMachiningLocation(page: Page, index: 0 | 1): Promise<void> {
  const group = propertyPanel(page).getByRole('group', { name: uiMessage('propertyPanel', 'propertyPanel.holeLocation'), exact: true });
  await expect(group).toHaveCount(1); await expect(group.getByRole('button')).toHaveCount(2);
  const button = (slot: number) => group.getByRole('button', {
    name: uiMessage('propertyPanel', 'propertyPanel.holeLocationNumber').replace('{index}', String(slot + 1)), exact: true });
  await expect(button(index)).toHaveCount(1); await button(index).click();
  await expect(button(index)).toHaveAttribute('aria-pressed', 'true');
  await expect(button(1 - index)).toHaveAttribute('aria-pressed', 'false');
}
export async function expectNoMachiningHistory(page: Page): Promise<void> {
  const history = page.getByRole('group', { name: uiMessage('toolbar', 'toolbar.history.groupLabel'), exact: true });
  for (const direction of ['undo', 'redo']) {
    const button = history.getByRole('button', { name: uiMessage('toolbar', `toolbar.history.${direction}`), exact: true });
    await expect(button).toHaveCount(1); await expect(button).toHaveAttribute('aria-disabled', 'true');
  }
}
async function openLocationMath(page: Page): Promise<Locator> {
  const label = `${uiMessage('numericInput', 'numericInput.field.holeCylinderHeight')}: ${uiMessage('math', 'math.open')}`;
  const button = propertyPanel(page).getByRole('button', { name: label, exact: true });
  await expect(button).toHaveCount(1); await button.click();
  const dialog = page.locator('.pcad-math-dialog');
  await expect(dialog).toHaveCount(1); await expect(dialog.locator('textarea')).toHaveCount(1);
  await expect(dialog.locator('textarea')).toBeVisible();
  return dialog;
}

export async function buildTwoLocationMachining(page: Page, info: TestInfo, entry: string,
  operation: TwoLocationOperation, app?: ElectronApplication): Promise<SavedTwoLocationMachining> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = await createTwoLocationFixture(operation), fixturePath = info.outputPath(`two-location-${operation}-fixture.pcad`);
  await writeFile(fixturePath, fixture);
  await prepare(page, info, entry); await openSaveFlowFile(page, fixturePath, app);
  const authored = ex18ReadPart(fixture).document, machining = twoLocationFeature(authored);
  const row = solidRow(page, machining.name);
  await expect(row).toHaveCount(1); await row.click(); await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expectNoMachiningHistory(page);
  const original = await save(page, info, 'two-original', app), before = ex18ReadPart(original.bytes).document;
  expect(before).toEqual(authored);
  const baseline = await expectTwoLocationMachining(original.bytes, operation, 'original', info, 'original');
  await selectMachiningLocation(page, 0);
  await expect(locationField(page, 'Height')).toHaveValue('10'); await expect(locationField(page, 'Angle')).toHaveValue('37');
  await selectMachiningLocation(page, 1);
  await expect(locationField(page, 'Height')).toHaveValue('28'); await expect(locationField(page, 'Angle')).toHaveValue('-53');
  // An incomplete draft must disappear when switching positions without creating a history entry.
  await fillUnique(locationField(page, 'Height'), '28', '7*');
  await expect(locationField(page, 'Height')).toHaveAttribute('aria-invalid', 'true');
  await selectMachiningLocation(page, 0); await expect(locationField(page, 'Height')).toHaveValue('10');
  await selectMachiningLocation(page, 1); await expect(locationField(page, 'Height')).toHaveValue('28');
  let dialog = await openLocationMath(page);
  await expect(dialog.locator('textarea')).toHaveValue('28'); await dialog.locator('textarea').fill('99');
  await dialog.getByRole('button', { name: uiMessage('math', 'math.cancel'), exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(locationField(page, 'Height')).toHaveValue('28');
  await expectNoMachiningHistory(page);
  const cancelled = await save(page, info, 'two-selection-cancelled', app);
  expect(ex18ReadPart(cancelled.bytes).document).toEqual(before);
  const unchanged = await expectTwoLocationMachining(cancelled.bytes, operation, 'original', info, 'selection-cancelled');
  expect(unchanged.shapeSha).toBe(baseline.shapeSha); expect(unchanged.brepSha).toBe(baseline.brepSha);
  // The same public math editor must write position 2, not the first position.
  dialog = await openLocationMath(page); await expect(dialog.locator('textarea')).toHaveValue('28');
  await dialog.locator('textarea').fill('8*3');
  const apply = dialog.getByRole('button', { name: uiMessage('math', 'math.apply'), exact: true });
  await expect(apply).toBeEnabled(); let token = await beginRecompute(page); await apply.click();
  await expect(dialog).toHaveCount(0); await waitForRecompute(page, token);
  await expect(locationField(page, 'Height')).toHaveValue('8*3');
  const heightSave = await save(page, info, 'two-height-edited', app), heightDocument = ex18ReadPart(heightSave.bytes).document;
  const heightFeature = twoLocationFeature(heightDocument), heightValue = heightFeature.cylindrical?.locations[1]?.height;
  expect(heightValue).toMatchObject({ source: '8*3', value: 24, mathDefinition: { format: 'pointercad-math/1' } });
  expect(heightFeature).toEqual({ ...machining, cylindrical: { ...machining.cylindrical, locations:
    machining.cylindrical?.locations.map((location, index) => index === 1 ? { ...location, height: heightValue } : location) } });
  expect(heightDocument).toEqual({ ...before, mathParameterSerial: 0, solids: before.solids.map(feature => feature.id === machining.id ? heightFeature : feature) });
  const heightNative = await expectTwoLocationMachining(heightSave.bytes, operation, 'height', info, 'height-edited');
  expect(heightNative.shapeSha).not.toBe(baseline.shapeSha);
  await selectMachiningLocation(page, 0); await expect(locationField(page, 'Height')).toHaveValue('10');
  await selectMachiningLocation(page, 1); await expect(locationField(page, 'Height')).toHaveValue('8*3');
  token = await beginRecompute(page); await fillUnique(locationField(page, 'Angle'), '-53', '-(20+51)');
  await row.click(); await waitForRecompute(page, token);
  const edited = await save(page, info, 'two-angle-edited', app), editedDocument = ex18ReadPart(edited.bytes).document;
  const editedFeature = twoLocationFeature(editedDocument), angleValue = editedFeature.cylindrical?.locations[1]?.angle;
  expect(angleValue).toMatchObject({ source: '-(20+51)', value: -71 });
  expect(editedFeature).toEqual({ ...heightFeature, cylindrical: { ...heightFeature.cylindrical, locations:
    heightFeature.cylindrical?.locations.map((location, index) => index === 1 ? { ...location, angle: angleValue } : location) } });
  expect(editedDocument).toEqual({ ...heightDocument, solids: heightDocument.solids.map(feature => feature.id === machining.id ? editedFeature : feature) });
  expect(editedFeature.id).toBe(machining.id); expect(editedFeature.face).toEqual(machining.face);
  expect(editedFeature.cylindrical?.locations[0]).toEqual(machining.cylindrical?.locations[0]);
  const finalNative = await expectTwoLocationMachining(edited.bytes, operation, 'edited', info, 'angle-edited');
  expect(finalNative.shapeSha).not.toBe(heightNative.shapeSha);
  await selectMachiningLocation(page, 0); await selectMachiningLocation(page, 1);
  const selected = await save(page, info, 'two-selected-final', app);
  expect(ex18ReadPart(selected.bytes).document).toEqual(editedDocument);
  // Two deliberate field edits: one Undo reverts only the last angle edit, retaining the height edit.
  await pressHistory(page, 'Control+z');
  const undone = await save(page, info, 'two-one-undo', app);
  expect(ex18ReadPart(undone.bytes).document).toEqual(heightDocument);
  const undoNative = await expectTwoLocationMachining(undone.bytes, operation, 'height', info, 'one-undo');
  expect(undoNative.shapeSha).toBe(heightNative.shapeSha); expect(undoNative.brepSha).toBe(heightNative.brepSha);
  await pressHistory(page, 'Control+y');
  const redone = await save(page, info, 'two-one-redo', app);
  expect(ex18ReadPart(redone.bytes).document).toEqual(editedDocument);
  const redoNative = await expectTwoLocationMachining(redone.bytes, operation, 'edited', info, 'one-redo');
  expect(redoNative.shapeSha).toBe(finalNative.shapeSha); expect(redoNative.brepSha).toBe(finalNative.brepSha);
  expect(errors).toEqual([]);
  return { path: redone.path, document: editedDocument, operation, shapeSha: finalNative.shapeSha, brepSha: finalNative.brepSha };
}

export async function reopenTwoLocationMachining(page: Page, info: TestInfo, entry: string,
  saved: SavedTwoLocationMachining, app?: ElectronApplication): Promise<void> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page, info, entry); await openSaveFlowFile(page, saved.path, app);
  const machining = twoLocationFeature(saved.document), row = solidRow(page, machining.name);
  await expect(row).toHaveCount(1); await row.click(); await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expectNoMachiningHistory(page);
  await selectMachiningLocation(page, 0);
  await expect(locationField(page, 'Height')).toHaveValue('10'); await expect(locationField(page, 'Angle')).toHaveValue('37');
  await selectMachiningLocation(page, 1);
  await expect(locationField(page, 'Height')).toHaveValue('8*3'); await expect(locationField(page, 'Angle')).toHaveValue('-(20+51)');
  await expectNoMachiningHistory(page);
  const reopened = await save(page, info, 'two-cold-reopened', app);
  expect(ex18ReadPart(reopened.bytes).document).toEqual(saved.document);
  const native = await expectTwoLocationMachining(reopened.bytes, saved.operation, 'edited', info, 'cold-reopened');
  expect(native.shapeSha).toBe(saved.shapeSha); expect(native.brepSha).toBe(saved.brepSha);
  expect(errors).toEqual([]);
}
