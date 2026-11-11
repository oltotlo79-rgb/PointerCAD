import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { PartDocument } from '../../packages/model/src/part/types.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { cancelPopover, clickWorldPoint, commitPopover, fillFields, popover, popoverInputs,
  popoverTitle, propertyPanel, selectionKindLabel, sketchTool, treeRow } from './solidCaptureSupport.js';
import { uiMessage } from './uiMessages.js';
import { ex18ReadPart } from './ex18RoutesOracle.js';
import { solidRow, field, fillUnique, save, prepare, pressHistory,
  selectMachiningLocation, expectNoMachiningHistory } from './machiningSurfaceFlow.js';
import { createPlanarFixture, expectPlanarNative, planarFeature, STOCK_NAME,
  type PlanarOperation, type PlanarPhase } from './planarMachiningOracle.js';

export type PlanarUiCase = 'create' | 'two-fixture' | 'missing-reference';
export function planarTitle(edition: 'Web' | 'Electron', operation: PlanarOperation, scenario: PlanarUiCase): string {
  const detail = scenario === 'missing-reference'
    ? 'suppressed fixture, unavailable basis, edit refusal zero history/native'
    : 'explicit native basis, signed source, zero cancel/selection, one edit Undo/Redo, cold PCAD native';
  return `EX-05.UI ${edition} plane-XY/${scenario}-${operation}: ${detail}`;
}
export interface SavedPlanarUi {
  readonly path: string;
  readonly document: PartDocument;
  readonly operation: PlanarOperation;
  readonly phase: PlanarPhase;
  readonly shapeSha: string;
  readonly brepSha: string;
}
const numeric = (key: string) => uiMessage('numericInput', `numericInput.${key}`);
function xy(page: Page, container: Locator, member: 'X' | 'Y'): Locator {
  return field(page, container, numeric(`field.holePlanar${member}`));
}
async function value(page: Page, key: string, source: string): Promise<void> {
  const input = field(page, popover(page), numeric(`field.${key}`));
  await expect(input).toHaveCount(1); await expect(input).toBeVisible();
  await fillUnique(input, await input.inputValue(), source);
}
async function toggle(page: Page, key: string, checked: boolean): Promise<void> {
  const button = popover(page).getByRole('switch', { name: numeric(`toggle.${key}`), exact: true });
  await expect(button).toHaveCount(1);
  const current = await button.getAttribute('aria-checked'); expect(['false', 'true']).toContain(current);
  if (current !== String(checked)) await button.click();
  await expect(button).toHaveAttribute('aria-checked', String(checked));
}
async function basis(container: Locator): Promise<void> {
  const note = container.getByRole('note'); await expect(note).toHaveCount(1);
  const values = [
    ['origin', '0, 0, 10'], ['xAxis', '1, 0, 0'], ['yAxis', '0, 1, 0'],
  ];
  for (const [key, expected] of values) {
    if (key === undefined || expected === undefined) throw new Error('基準の固定期待がありません');
    const label = note.locator('dt').filter({ hasText: numeric(`planarBasis.${key}`) });
    await expect(label).toHaveCount(1); await expect(label.locator('xpath=following-sibling::dd[1]')).toHaveText(expected);
  }
  await expect(note).toContainText(numeric('planarBasis.note'));
}
async function choosePlacement(page: Page, mode: 'points' | 'plane-face'): Promise<void> {
  const group = popover(page).getByRole('group', { name: numeric('choice.holePlacement'), exact: true });
  await expect(group).toHaveCount(1);
  const button = group.getByRole('button', { name: numeric(mode === 'points' ? 'holePlacement.points' : 'holePlacement.planeFace'), exact: true });
  await expect(button).toHaveCount(1); await button.click(); await expect(button).toHaveAttribute('aria-pressed', 'true');
}
async function beginPlanar(page: Page, operation: PlanarOperation, withPoint = false): Promise<void> {
  const row = solidRow(page, STOCK_NAME); await expect(row).toHaveCount(1); await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.select')).click();
  const canvas = page.locator('canvas.pcad-viewport__canvas'); await canvas.press('Home'); await canvas.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [0, 0, 10]);
  if (withPoint) { await expect(treeRow(page, '点1')).toHaveCount(1); await treeRow(page, '点1').click({ modifiers: ['Shift'] }); }
  await chooseToolMenuItem(page, '加工', uiMessage('toolbar', operation === 'plain' ? 'toolbar.machining.hole' : 'toolbar.machining.threadHole'));
  await expect(popoverTitle(page)).toHaveText(numeric(operation === 'plain' ? 'title.hole' : 'title.threadHole'));
  const points = popover(page).getByRole('button', { name: numeric('holePlacement.points'), exact: true });
  await expect(points).toHaveCount(1); await expect(points).toHaveAttribute('aria-pressed', 'true');
  await expect(xy(page, popover(page), 'X')).toHaveCount(0);
  await choosePlacement(page, 'plane-face');
  await basis(popover(page));
  await expect(xy(page, popover(page), 'X')).toHaveValue(''); await expect(xy(page, popover(page), 'Y')).toHaveValue('');
  await toggle(page, 'through', true);
  if (operation === 'plain') await value(page, 'diameter', '6');
  else {
    await expect(popover(page).locator('.pcad-menu__count')).toHaveText('M6');
    await toggle(page, 'modeledThread', false); await value(page, 'threadLength', '1');
  }
}
async function fillXY(page: Page): Promise<void> {
  await fillUnique(xy(page, popover(page), 'X'), '', '2*3');
  await fillUnique(xy(page, popover(page), 'Y'), '', '-2*2');
}
async function openMath(page: Page, member: 'X' | 'Y'): Promise<Locator> {
  const button = propertyPanel(page).getByRole('button', {
    name: `${numeric(`field.holePlanar${member}`)}: ${uiMessage('math', 'math.open')}`, exact: true });
  await expect(button).toHaveCount(1); await button.click();
  const dialog = page.locator('.pcad-math-dialog'); await expect(dialog).toHaveCount(1);
  await expect(dialog.locator('textarea')).toHaveCount(1); await expect(dialog.locator('textarea')).toBeVisible();
  return dialog;
}
async function unchanged(page: Page, info: TestInfo, label: string, operation: PlanarOperation,
  phase: PlanarPhase, before: Awaited<ReturnType<typeof expectPlanarNative>>, app?: ElectronApplication): Promise<void> {
  const saved = await save(page, info, label, app); expect(ex18ReadPart(saved.bytes).document).toEqual(before.document);
  const actual = await expectPlanarNative(saved.bytes, operation, phase, info, label);
  expect(actual.shapeSha).toBe(before.shapeSha); expect(actual.brepSha).toBe(before.brepSha);
}
async function coldCache(page: Page): Promise<void> {
  const state = await readRecomputeStats(page); expect(state.lastOutcome).toBe('success'); expect(state.cacheHits).toBe(0);
}
async function fixture(page: Page, info: TestInfo, entry: string, operation: PlanarOperation,
  kind: 'stock' | 'two' | 'missing', app?: ElectronApplication): Promise<void> {
  const bytes = await createPlanarFixture(operation, kind), path = info.outputPath(`planar-${operation}-${kind}-fixture.pcad`);
  await writeFile(path, bytes); await prepare(page, info, entry); await openSaveFlowFile(page, path, app);
  await coldCache(page); await expectNoMachiningHistory(page);
}
async function history(page: Page, info: TestInfo, operation: PlanarOperation,
  before: Awaited<ReturnType<typeof expectPlanarNative>>, after: Awaited<ReturnType<typeof expectPlanarNative>>,
  beforePhase: PlanarPhase, afterPhase: PlanarPhase, app?: ElectronApplication) {
  await pressHistory(page, 'Control+z'); await unchanged(page, info, 'one-undo', operation, beforePhase, before, app);
  await pressHistory(page, 'Control+y'); await unchanged(page, info, 'one-redo', operation, afterPhase, after, app);
}

/** 素材だけは明示fixture。穴/ねじ穴の作成・編集は全て普通の画面操作。 */
export async function buildPlanarCreate(page: Page, info: TestInfo, entry: string,
  operation: PlanarOperation, app?: ElectronApplication): Promise<SavedPlanarUi> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await fixture(page, info, entry, operation, 'stock', app);
  const seed = await save(page, info, 'planar-seed', app), seedDocument = ex18ReadPart(seed.bytes).document;
  // 普通の点作成を、取消/不成立後に余分なUndoが無いことを確認する履歴マーカーにする。
  await sketchTool(page, uiMessage('toolbar', 'toolbar.tool.point')).click();
  await expect(popoverInputs(page)).toHaveCount(3); await fillFields(page, ['-15', '-10', '0']);
  await commitPopover(page); await cancelPopover(page);
  const ready = await save(page, info, 'planar-ready', app);
  const baseline = await expectPlanarNative(ready.bytes, operation, 'blank', info, 'ready');
  for (const invalid of ['', '1e309', '2*']) {
    await beginPlanar(page, operation);
    await fillUnique(xy(page, popover(page), 'X'), '', invalid);
    await fillUnique(xy(page, popover(page), 'Y'), '', '-2*2');
    await commitPopover(page); await expect(popover(page)).toHaveCount(1);
    await expect(xy(page, popover(page), 'X')).toHaveAttribute('aria-invalid', 'true');
    await expect(popover(page).locator('.pcad-field__message--error').first()).not.toBeEmpty();
    await cancelPopover(page); await unchanged(page, info, `refused-${invalid === '' ? 'empty' : invalid === '1e309' ? 'nonfinite' : 'syntax'}`, operation, 'blank', baseline, app);
  }
  await beginPlanar(page, operation);
  const cylinder = popover(page).getByRole('switch', { name: numeric('toggle.cylinderFace'), exact: true });
  await expect(cylinder).toBeDisabled();
  await choosePlacement(page, 'points'); await toggle(page, 'cylinderFace', true);
  await expect(popover(page).getByRole('button', { name: numeric('holePlacement.planeFace'), exact: true })).toHaveCount(0);
  await cancelPopover(page); await unchanged(page, info, 'cylinder-conflict-prevented', operation, 'blank', baseline, app);
  await beginPlanar(page, operation, true); await fillXY(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(1);
  await expect(page.locator('.pcad-statusbar__text')).toContainText(numeric('error.planarHoleConflict'));
  await cancelPopover(page); await unchanged(page, info, 'point-conflict', operation, 'blank', baseline, app);
  // 不成立/取消が履歴へ入れば、この一度のUndoで点作成前へ戻れない。
  await pressHistory(page, 'Control+z');
  const undone = await save(page, info, 'cancel-history-undo', app);
  expect(ex18ReadPart(undone.bytes).document).toEqual(seedDocument);
  await pressHistory(page, 'Control+y'); await unchanged(page, info, 'cancel-history-redo', operation, 'blank', baseline, app);
  await beginPlanar(page, operation); await fillXY(page);
  let token = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  const created = await save(page, info, 'planar-created', app);
  const original = await expectPlanarNative(created.bytes, operation, 'single-created', info, 'created');
  const feature = planarFeature(original.document);
  expect(feature.kind).toBe(operation === 'plain' ? 'hole' : 'threadHole');
  expect(feature.planar?.locations).toHaveLength(1);
  expect(feature.planar?.locations[0]?.x).toMatchObject({ source: '2*3', value: 6 });
  expect(feature.planar?.locations[0]?.y).toMatchObject({ source: '-2*2', value: -4 });
  const row = solidRow(page, feature.name); await expect(row).toHaveCount(1); await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true'); await basis(propertyPanel(page));
  await expect(propertyPanel(page).getByRole('group', { name: uiMessage('propertyPanel', 'propertyPanel.holeLocation'), exact: true })).toHaveCount(0);
  const dialog = await openMath(page, 'Y'); await expect(dialog.locator('textarea')).toHaveValue('Multiply(Negate(2),2)');
  await dialog.locator('textarea').fill('99');
  await dialog.getByRole('button', { name: uiMessage('math', 'math.cancel'), exact: true }).click();
  await expect(dialog).toHaveCount(0); await unchanged(page, info, 'math-cancelled', operation, 'single-created', original, app);
  token = await beginRecompute(page);
  await fillUnique(xy(page, propertyPanel(page), 'Y'), '-2*2', '-(1+4)'); await row.click(); await waitForRecompute(page, token);
  const edited = await save(page, info, 'planar-edited', app);
  const final = await expectPlanarNative(edited.bytes, operation, 'single-edited', info, 'edited');
  const changed = planarFeature(final.document);
  expect(changed).toEqual({ ...feature, planar: { ...feature.planar, locations: [{
    x: feature.planar?.locations[0]?.x, y: changed.planar?.locations[0]?.y,
  }] } });
  expect(changed.planar?.locations[0]?.y).toMatchObject({ source: '-(1+4)', value: -5 });
  expect(final.document).toEqual({ ...original.document, solids: original.document.solids.map(item => item.id === feature.id ? changed : item) });
  expect(changed.id).toBe(feature.id); expect(changed.face).toEqual(feature.face);
  expect(final.shapeSha).not.toBe(original.shapeSha);
  await history(page, info, operation, original, final, 'single-created', 'single-edited', app);
  const saved = await save(page, info, 'planar-final', app); expect(errors).toEqual([]);
  return { path: saved.path, document: final.document, operation, phase: 'single-edited', shapeSha: final.shapeSha, brepSha: final.brepSha };
}

/** 2位置の作成UIとは数えない。公開model/IOの明示fixtureを普通に開き編集する。 */
export async function buildPlanarTwoFixture(page: Page, info: TestInfo, entry: string,
  operation: PlanarOperation, app?: ElectronApplication): Promise<SavedPlanarUi> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await fixture(page, info, entry, operation, 'two', app);
  const start = await save(page, info, 'planar-two-original', app);
  const original = await expectPlanarNative(start.bytes, operation, 'two-original', info, 'two-original');
  const feature = planarFeature(original.document), row = solidRow(page, feature.name);
  await expect(row).toHaveCount(1); await row.click(); await basis(propertyPanel(page));
  await selectMachiningLocation(page, 0); await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('6');
  await selectMachiningLocation(page, 1); await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('-3');
  await fillUnique(xy(page, propertyPanel(page), 'X'), '-3', '2*');
  await expect(xy(page, propertyPanel(page), 'X')).toHaveAttribute('aria-invalid', 'true');
  await selectMachiningLocation(page, 0); await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('6');
  await selectMachiningLocation(page, 1); await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('-3');
  let dialog = await openMath(page, 'X'); await expect(dialog.locator('textarea')).toHaveValue('Negate(3)');
  await dialog.locator('textarea').fill('99');
  await dialog.getByRole('button', { name: uiMessage('math', 'math.cancel'), exact: true }).click();
  await expect(dialog).toHaveCount(0); await expectNoMachiningHistory(page);
  await unchanged(page, info, 'two-selection-cancelled', operation, 'two-original', original, app);
  dialog = await openMath(page, 'X'); await dialog.locator('textarea').fill('-(2*4)');
  const apply = dialog.getByRole('button', { name: uiMessage('math', 'math.apply'), exact: true });
  await expect(apply).toBeEnabled(); const token = await beginRecompute(page); await apply.click();
  await expect(dialog).toHaveCount(0); await waitForRecompute(page, token);
  await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('-(2*4)');
  const edited = await save(page, info, 'planar-two-edited', app);
  const final = await expectPlanarNative(edited.bytes, operation, 'two-edited', info, 'two-edited');
  const changed = planarFeature(final.document), value = changed.planar?.locations[1]?.x;
  expect(value).toMatchObject({ source: '-(2*4)', value: -8, mathDefinition: { format: 'pointercad-math/1' } });
  expect(changed).toEqual({ ...feature, planar: { ...feature.planar, locations:
    feature.planar?.locations.map((location, index) => index === 1 ? { ...location, x: value } : location) } });
  expect(changed.planar?.locations[0]).toEqual(feature.planar?.locations[0]);
  expect(changed.id).toBe(feature.id); expect(changed.face).toEqual(feature.face);
  expect(final.document).toEqual({ ...original.document, mathParameterSerial: 0,
    solids: original.document.solids.map(item => item.id === feature.id ? changed : item) });
  await selectMachiningLocation(page, 0); await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('6');
  await selectMachiningLocation(page, 1); await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('-(2*4)');
  await unchanged(page, info, 'two-selected-final', operation, 'two-edited', final, app);
  await history(page, info, operation, original, final, 'two-original', 'two-edited', app);
  const saved = await save(page, info, 'planar-two-final', app); expect(errors).toEqual([]);
  return { path: saved.path, document: final.document, operation, phase: 'two-edited', shapeSha: final.shapeSha, brepSha: final.brepSha };
}

/** 未知の保存面参照を持つ抑制featureの編集拒否。未知参照の作成成功とは数えない。 */
export async function buildPlanarMissingReference(page: Page, info: TestInfo, entry: string,
  app?: ElectronApplication): Promise<void> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await fixture(page, info, entry, 'plain', 'missing', app);
  const start = await save(page, info, 'missing-reference-before', app);
  const before = await expectPlanarNative(start.bytes, 'plain', 'missing-reference', info, 'missing-before');
  const feature = planarFeature(before.document), row = solidRow(page, feature.name);
  await expect(row).toHaveCount(1); await row.click(); await selectMachiningLocation(page, 1);
  await expect(propertyPanel(page).getByText(numeric('error.planarHoleBasis'), { exact: true })).toHaveCount(1);
  await expect(propertyPanel(page).getByRole('note')).toHaveCount(0);
  await fillUnique(xy(page, propertyPanel(page), 'X'), '-3', '-8');
  await expectNoMachiningHistory(page);
  await unchanged(page, info, 'missing-reference-refused', 'plain', 'missing-reference', before, app);
  await selectMachiningLocation(page, 0); await selectMachiningLocation(page, 1);
  const dialog = await openMath(page, 'X'); await expect(dialog.locator('textarea')).toHaveValue('Negate(3)');
  await dialog.locator('textarea').fill('12/2');
  const apply = dialog.getByRole('button', { name: uiMessage('math', 'math.apply'), exact: true });
  await expect(apply).toBeEnabled(); await apply.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(numeric('error.planarHoleBasis'), { exact: true })).toHaveCount(1);
  await dialog.getByRole('button', { name: uiMessage('math', 'math.cancel'), exact: true }).click();
  await expect(dialog).toHaveCount(0); await expectNoMachiningHistory(page);
  await unchanged(page, info, 'missing-reference-math-refused', 'plain', 'missing-reference', before, app);
  expect(errors).toEqual([]);
}

export async function reopenPlanarUi(page: Page, info: TestInfo, entry: string,
  saved: SavedPlanarUi, app?: ElectronApplication): Promise<void> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page, info, entry); await openSaveFlowFile(page, saved.path, app); await coldCache(page);
  const feature = planarFeature(saved.document), row = solidRow(page, feature.name);
  await expect(row).toHaveCount(1); await row.click(); await basis(propertyPanel(page));
  await expectNoMachiningHistory(page);
  if (saved.phase === 'two-edited') {
    await selectMachiningLocation(page, 0);
    await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('6'); await expect(xy(page, propertyPanel(page), 'Y')).toHaveValue('-4');
    await selectMachiningLocation(page, 1);
    await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('-(2*4)'); await expect(xy(page, propertyPanel(page), 'Y')).toHaveValue('5');
  } else {
    await expect(xy(page, propertyPanel(page), 'X')).toHaveValue('2*3'); await expect(xy(page, propertyPanel(page), 'Y')).toHaveValue('-(1+4)');
  }
  await expectNoMachiningHistory(page);
  const reopened = await save(page, info, 'planar-cold-reopened', app);
  expect(ex18ReadPart(reopened.bytes).document).toEqual(saved.document);
  const native = await expectPlanarNative(reopened.bytes, saved.operation, saved.phase, info, 'cold-reopened');
  expect(native.shapeSha).toBe(saved.shapeSha); expect(native.brepSha).toBe(saved.brepSha);
  expect(errors).toEqual([]);
}
