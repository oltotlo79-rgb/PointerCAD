/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, readDrawingBundle, readPcadFile } from '../../packages/io/src/index.js';
import { openTarget, saveTarget } from './electronAppFlow.js';
import { waitForDrawingReady } from './drawingManufacturingFixture.js';
import { beginRecompute, readRecomputeStats, waitForRecomputeOutcome, type RecomputeToken } from './recompute.js';
import { treeRow } from './solidCaptureSupport.js';
import { uiMessage } from './uiMessages.js';
import {
  AMBIGUITY_HOLE_NAME, ambiguousAppearancePart, ambiguousDimensionDrawing, ambiguousHolePart, ambiguousMateAssembly,
  buildReferenceAmbiguityScenario, nativeRepairPreviewFixture, referenceRepairDrawingFixture, type ReferenceAmbiguityScenario,
} from './referenceAmbiguityFixture.js';
import { referenceRepairAppearanceFixture } from './referenceRepairAppearanceFixture.js';

/**
 * R01: 参照が曖昧(ambiguous)・消失(missing)になった時、寸法・合致・加工面・外観のどれも正常な値として採らず、
 * 未解決の表示を出し、保存した元の参照を保つことを実画面で確かめる。
 * 各用途で ① 開いた直後の表示 ② 無関係な編集のUndo/Redo各1回 ③ 保存した文書の参照が元と同じ ④ 開き直しても同じ、を見る。
 * 参照を持つ文書は `referenceAmbiguityFixture.ts` が実OCCTで作る(R17の修復の画面検査もそれを使う)。
 */
export type ReferenceAmbiguityUse = 'dimension' | 'mate' | 'machining' | 'appearance';

const UNDO = '元に戻す', REDO = 'やり直す';
const MATE_TARGET_ERROR = '合致の対象が見つかりません';
const HOLE_FACE_ERROR = '穴をあけるもとの面が見つかりません';

/** 保存した文書を読み、元の保存内容と画面操作後の保存内容を比べる入れ物。 */
async function readSaved(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

async function saveBytes(page: Page, info: TestInfo, name: string, focus: Locator, app?: ElectronApplication): Promise<Uint8Array> {
  const path = info.outputPath(name);
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await focus.focus();
  await page.keyboard.press('Control+Shift+s');
  if (download !== undefined) await (await download).saveAs(path);
  else await expect.poll(async () => (await readSaved(path).catch(() => new Uint8Array())).length).toBeGreaterThan(100);
  return readSaved(path);
}

const canvas = (page: Page): Locator => page.locator('canvas.pcad-viewport__canvas');
const sheet = (page: Page): Locator => page.locator('.pcad-drawing-sheet');
const undoButton = (page: Page): Locator => page.getByRole('button', { name: UNDO, exact: true });
const redoButton = (page: Page): Locator => page.getByRole('button', { name: REDO, exact: true });

/** 文書を開く。Webは「開く」のファイル選択、Electronは開くダイアログの差し替え。 */
async function openFixture(page: Page, path: string, app?: ElectronApplication): Promise<void> {
  const open = page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true });
  await expect(open).toBeVisible();
  if (app !== undefined) {
    await openTarget(app, path);
    await open.click();
    return;
  }
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()]);
  await chooser.setFiles(path);
}

/** 画面を読み込み直してから、保存した文書を開き直す。 */
async function reloadPage(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.pcadRecomputeStats === 'function');
  await page.reload();
  await expect(page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true })).toBeVisible();
  await page.waitForFunction(() => typeof window.pcadRecomputeStats === 'function');
}

async function openAndWait(page: Page, path: string, outcome: 'success' | 'failed' | 'drawing', app?: ElectronApplication): Promise<void> {
  const token: RecomputeToken | undefined = outcome === 'drawing' ? undefined : await beginRecompute(page);
  await openFixture(page, path, app);
  if (outcome === 'drawing') await waitForDrawingReady(page);
  else await waitForRecomputeOutcome(page, token, outcome);
}

async function writeFixture(info: TestInfo, name: string, bytes: Uint8Array): Promise<string> {
  const path = info.outputPath(name);
  await writeFile(path, bytes);
  return path;
}

/* ------------------------------------------------------------------ 寸法 */

const NORMAL_VALUE = /(^|\D)(10|40)(\D|$)/u;

async function expectDimensionStates(page: Page, withControl: boolean): Promise<void> {
  const rows = page.locator('.pcad-drawing-tree-dimension');
  await expect(rows).toHaveCount(withControl ? 3 : 2);
  await expect(page.getByTestId('drawing-status-unresolved')).toHaveText('未解決 2');
  await expect(page.locator('.pcad-drawing-tree-unresolved')).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect(rows.nth(index).locator('.pcad-drawing-tree-unresolved')).toHaveCount(1);
    await expect(rows.nth(index)).toContainText(/[?？]/u);
    const label = (await rows.nth(index).textContent()) ?? '';
    expect(label, `未解決の寸法に正常値が出ない: ${label}`).not.toMatch(NORMAL_VALUE);
  }
  if (withControl) {
    await expect(rows.nth(2).locator('.pcad-drawing-tree-unresolved')).toHaveCount(0);
    await expect(rows.nth(2)).toContainText('100');
  }
  for (const id of ['dim-ambiguous', 'dim-missing']) {
    const texts = await page.locator(`.pcad-drawing-svg [data-owner-id="${id}"]`).evaluateAll(owners => owners.flatMap(owner => [
      ...Array.from(owner.querySelectorAll('[aria-label]')).map(element => element.getAttribute('aria-label') ?? ''),
      ...Array.from(owner.querySelectorAll('text')).map(element => element.textContent ?? '')]));
    for (const text of texts) expect(text, `${id} の図面上の文字に正常値が出ない`).not.toMatch(NORMAL_VALUE);
  }
}

async function savedDrawing(page: Page, info: TestInfo, name: string, app?: ElectronApplication) {
  const read = await readDrawingBundle(await saveBytes(page, info, name, sheet(page), app));
  if (!read.ok) throw new Error(read.error.message);
  return read.document;
}

async function dimensionFlow(page: Page, info: TestInfo, scenario: ReferenceAmbiguityScenario, app?: ElectronApplication): Promise<void> {
  const fixture = await ambiguousDimensionDrawing(scenario);
  const input = await writeFixture(info, 'reference-dimension.pcadd', fixture.bytes);
  await openAndWait(page, input, 'drawing', app);
  await expectDimensionStates(page, true);
  const baseline = await savedDrawing(page, info, 'dimension-baseline.pcadd', app);
  // 元の参照は、曖昧・消失のままそっくり保存される(ほかの対象へつなぎ直さない)。
  expect(baseline.dimensions[0].targets[0]).toMatchObject({ kind: 'subShape', ref: scenario.refs.ambiguousEdge });
  expect(baseline.dimensions[1].targets[0]).toMatchObject({ kind: 'subShape', ref: scenario.refs.missingEdge });

  // 無関係な一意の寸法を削除し、Undo 1回・Redo 1回しても、未解決の2本と元の参照は変わらない。
  await page.locator('.pcad-drawing-tree-dimension').nth(2).click();
  await sheet(page).focus();
  await page.keyboard.press('Delete');
  await waitForDrawingReady(page);
  await expectDimensionStates(page, false);
  const deleted = await savedDrawing(page, info, 'dimension-deleted.pcadd', app);
  expect(deleted.dimensions.map(item => item.targets)).toEqual(baseline.dimensions.slice(0, 2).map(item => item.targets));
  await sheet(page).focus();
  await page.keyboard.press('Control+z');
  await waitForDrawingReady(page);
  await expectDimensionStates(page, true);
  expect(await savedDrawing(page, info, 'dimension-undo.pcadd', app)).toEqual(baseline);
  await sheet(page).focus();
  await page.keyboard.press('Control+y');
  await waitForDrawingReady(page);
  await expectDimensionStates(page, false);
  expect(await savedDrawing(page, info, 'dimension-redo.pcadd', app)).toEqual(deleted);
  await sheet(page).focus();
  await page.keyboard.press('Control+z');
  await waitForDrawingReady(page);
  await expectDimensionStates(page, true);

  // 保存→開き直しでも、未解決の状態と元の参照は同じ。
  const final = await saveBytes(page, info, 'dimension-final.pcadd', sheet(page), app);
  await reloadPage(page);
  await openAndWait(page, info.outputPath('dimension-final.pcadd'), 'drawing', app);
  await expectDimensionStates(page, true);
  const reread = await readDrawingBundle(final);
  if (!reread.ok) throw new Error(reread.error.message);
  expect(await savedDrawing(page, info, 'dimension-reopened.pcadd', app)).toEqual(reread.document);
}

/* ------------------------------------------------------------------ 合致 */

function mateRows(page: Page): Locator {
  return page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: '合致' }),
  }).locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
}

async function expectMateStates(page: Page, withControl: boolean): Promise<void> {
  const rows = mateRows(page);
  await expect(rows).toHaveCount(withControl ? 3 : 2);
  const offset = withControl ? 1 : 0;
  if (withControl) {
    await rows.nth(0).locator('.pcad-tree__select').click();
    await expect(page.locator('.pcad-property-list')).toContainText('解決済み');
    await expect(page.locator('.pcad-property-list')).not.toContainText('未解決');
  }
  for (const index of [offset, offset + 1]) {
    await expect(rows.nth(index)).toContainText(/未確定|未解決/u);
    await expect(rows.nth(index).locator('.pcad-tree__alert')).toHaveAttribute('title', new RegExp(MATE_TARGET_ERROR, 'u'));
    await rows.nth(index).locator('.pcad-tree__select').click();
    await expect(page.locator('.pcad-property-list')).toContainText('未解決');
    await expect(page.locator('.pcad-property-list')).not.toContainText('解決済み');
  }
}

async function savedMates(page: Page, info: TestInfo, name: string, app?: ElectronApplication) {
  const read = await readDocumentBundle(await saveBytes(page, info, name, canvas(page), app), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error(JSON.stringify(read.ok ? 'not assembly' : read.error));
  return read.bundle.document;
}

async function mateFlow(page: Page, info: TestInfo, scenario: ReferenceAmbiguityScenario, app?: ElectronApplication): Promise<void> {
  const fixture = await ambiguousMateAssembly(scenario);
  const input = await writeFixture(info, 'reference-mate.pcada', fixture.bytes);
  await openAndWait(page, input, 'failed', app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await expectMateStates(page, true);
  const baseline = await savedMates(page, info, 'mate-baseline.pcada', app);
  expect(baseline.mates).toHaveLength(3);
  expect(baseline.mates[1].a).toMatchObject({ kind: 'subShape', ref: scenario.refs.ambiguousFace });
  expect(baseline.mates[2].a).toMatchObject({ kind: 'subShape', ref: scenario.refs.missingFace });

  // 一意の合致を削除→Undo 1回→Redo 1回。曖昧・消失の合致は未解決のまま、元の参照も変わらない。
  const deleteControl = async (): Promise<void> => {
    const token = await beginRecompute(page);
    await mateRows(page).nth(0).locator('.pcad-tree__more').click();
    const item = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '削除する', exact: true });
    await expect(item).toBeVisible();
    await item.click();
    await waitForRecomputeOutcome(page, token, 'failed');
  };
  const press = async (button: Locator): Promise<void> => {
    const token = await beginRecompute(page);
    await button.click();
    await waitForRecomputeOutcome(page, token, 'failed');
  };
  await deleteControl();
  await expectMateStates(page, false);
  const deleted = await savedMates(page, info, 'mate-deleted.pcada', app);
  expect(deleted.mates.map(mate => mate.id)).toEqual(['mate-2', 'mate-3']);
  expect(deleted.mates).toEqual(baseline.mates.slice(1));
  await press(undoButton(page));
  await expectMateStates(page, true);
  expect((await savedMates(page, info, 'mate-undo.pcada', app)).mates).toEqual(baseline.mates);
  await press(redoButton(page));
  await expectMateStates(page, false);
  expect((await savedMates(page, info, 'mate-redo.pcada', app)).mates).toEqual(deleted.mates);
  await press(undoButton(page));
  await expectMateStates(page, true);

  await saveBytes(page, info, 'mate-final.pcada', canvas(page), app);
  await reloadPage(page);
  await openAndWait(page, info.outputPath('mate-final.pcada'), 'failed', app);
  await expectMateStates(page, true);
  expect((await savedMates(page, info, 'mate-reopened.pcada', app)).mates).toEqual(baseline.mates);
}

/* ------------------------------------------------------------------ 加工・外観(部品) */

async function suppressSpareBox(page: Page, name: string, outcome: 'success' | 'failed'): Promise<void> {
  const token = await beginRecompute(page);
  await treeRow(page, name).click({ button: 'right' });
  const item = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: uiMessage('view', 'featureTree.suppress'), exact: true });
  await expect(item).toBeVisible();
  await item.click();
  await waitForRecomputeOutcome(page, token, outcome);
}

async function pressHistory(page: Page, button: Locator, outcome: 'success' | 'failed'): Promise<void> {
  const token = await beginRecompute(page);
  await button.click();
  await waitForRecomputeOutcome(page, token, outcome);
}

async function savedPart(page: Page, info: TestInfo, name: string, app?: ElectronApplication) {
  const read = readPcadFile(await saveBytes(page, info, name, canvas(page), app));
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.document;
}

async function expectHoleUnresolved(page: Page): Promise<void> {
  await expect(treeRow(page, AMBIGUITY_HOLE_NAME)).toBeVisible();
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(1);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveAttribute('title', new RegExp(HOLE_FACE_ERROR, 'u'));
}

async function machiningFlow(page: Page, info: TestInfo, scenario: ReferenceAmbiguityScenario, app?: ElectronApplication): Promise<void> {
  const fixture = ambiguousHolePart(scenario);
  const input = await writeFixture(info, 'reference-hole.pcad', fixture.bytes);
  await openAndWait(page, input, 'failed', app);
  await expectHoleUnresolved(page);
  const baseline = await savedPart(page, info, 'hole-baseline.pcad', app);
  const hole = baseline.solids.find(solid => solid.kind === 'hole');
  expect(hole).toMatchObject({ face: scenario.refs.ambiguousFace });

  await suppressSpareBox(page, fixture.spareName, 'failed');
  await expectHoleUnresolved(page);
  const suppressed = await savedPart(page, info, 'hole-suppressed.pcad', app);
  expect(suppressed.solids.find(solid => solid.kind === 'hole')).toEqual(hole);
  await pressHistory(page, undoButton(page), 'failed');
  await expectHoleUnresolved(page);
  expect(await savedPart(page, info, 'hole-undo.pcad', app)).toEqual(baseline);
  await pressHistory(page, redoButton(page), 'failed');
  await expectHoleUnresolved(page);
  expect(await savedPart(page, info, 'hole-redo.pcad', app)).toEqual(suppressed);
  await pressHistory(page, undoButton(page), 'failed');

  await saveBytes(page, info, 'hole-final.pcad', canvas(page), app);
  await reloadPage(page);
  await openAndWait(page, info.outputPath('hole-final.pcad'), 'failed', app);
  await expectHoleUnresolved(page);
  expect(await savedPart(page, info, 'hole-reopened.pcad', app)).toEqual(baseline);
}

/** 立体を選ぶと、右の外観の欄に「見つからない割り当て」が出る(曖昧と消失の2面)。 */
async function expectAppearanceUnresolved(page: Page): Promise<void> {
  await treeRow(page, 'U字の柱').click();
  await expect(page.locator('.pcad-panel--right').getByText('見つからない割り当て', { exact: true })).toBeVisible();
  await expect(page.locator('.pcad-appearance-missing__row')).toHaveCount(2);
}

async function appearanceFlow(page: Page, info: TestInfo, scenario: ReferenceAmbiguityScenario, app?: ElectronApplication): Promise<void> {
  const fixture = ambiguousAppearancePart(scenario);
  const input = await writeFixture(info, 'reference-appearance.pcad', fixture.bytes);
  await openAndWait(page, input, 'success', app);
  await expectAppearanceUnresolved(page);
  const baseline = await savedPart(page, info, 'appearance-baseline.pcad', app);
  expect(baseline.appearance.entries.map(entry => entry.target)).toEqual([
    { kind: 'face', ref: scenario.refs.ambiguousFace }, { kind: 'face', ref: scenario.refs.missingFace },
    { kind: 'face', ref: scenario.refs.uniqueFace }]);

  await suppressSpareBox(page, fixture.spareName, 'success');
  await expectAppearanceUnresolved(page);
  const suppressed = await savedPart(page, info, 'appearance-suppressed.pcad', app);
  expect(suppressed.appearance).toEqual(baseline.appearance);
  await pressHistory(page, undoButton(page), 'success');
  await expectAppearanceUnresolved(page);
  expect(await savedPart(page, info, 'appearance-undo.pcad', app)).toEqual(baseline);
  await pressHistory(page, redoButton(page), 'success');
  await expectAppearanceUnresolved(page);
  expect(await savedPart(page, info, 'appearance-redo.pcad', app)).toEqual(suppressed);
  await pressHistory(page, undoButton(page), 'success');

  await saveBytes(page, info, 'appearance-final.pcad', canvas(page), app);
  await reloadPage(page);
  await openAndWait(page, info.outputPath('appearance-final.pcad'), 'success', app);
  await expectAppearanceUnresolved(page);
  expect(await savedPart(page, info, 'appearance-reopened.pcad', app)).toEqual(baseline);
}

/**
 * 1用途ぶんの検査。`mirror` は形を左右反転して候補の番号の並びを入れ替える(同じ結果になること)。
 */
export async function referenceAmbiguityFlow(page: Page, info: TestInfo, use: ReferenceAmbiguityUse,
  options: { readonly mirror?: boolean; readonly app?: ElectronApplication } = {}): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scenario = await buildReferenceAmbiguityScenario(options.mirror === true);
  if (use === 'dimension') await dimensionFlow(page, info, scenario, options.app);
  else if (use === 'mate') await mateFlow(page, info, scenario, options.app);
  else if (use === 'machining') await machiningFlow(page, info, scenario, options.app);
  else await appearanceFlow(page, info, scenario, options.app);
}


/** R17: actual property controls; hover/cancel never become document history. */
export async function referenceRepairAppearanceFlow(page: Page, info: TestInfo,
  options: { readonly app?: ElectronApplication } = {}): Promise<void> {
  const app = options.app;
  await page.setViewportSize({ width: 1440, height: 900 });
  const { scenario, chosen } = await referenceRepairAppearanceFixture();
  const fixture = ambiguousAppearancePart(scenario);
  const input = await writeFixture(info, 'repair-appearance-input.pcad', fixture.bytes);
  await openAndWait(page, input, 'success', app);
  // The independently chosen +Y face is behind the home camera (-Y), and the
  // original 300 mm tall body exceeds its initial frame. Use actual camera input
  // before either screenshot; all hover/cancel comparisons then share this view.
  const viewport = canvas(page), bounds = await viewport.boundingBox();
  if (bounds === null) throw new Error('Actual appearance viewport missing');
  await viewport.focus(); await page.keyboard.press('Home');
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x - 200, y);
  await page.mouse.up({ button: 'middle' });
  await page.mouse.wheel(0, 1800);
  await expect.poll(() => page.evaluate(() => window.pcadViewportFramedBodies?.() ?? []),
    { message: 'Actual U body must be fully framed before the appearance comparison' }).toContain(scenario.body.featureId);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
  await expectAppearanceUnresolved(page);
  const baseline = await savedPart(page, info, 'repair-appearance-baseline.pcad', app);
  expect(baseline).toEqual(fixture.document);
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeDisabled();
  const entry = baseline.appearance.entries[0];
  if (entry === undefined || entry.target.kind !== 'face') throw new Error('曖昧な外観の面がありません。');
  expect(entry.target.ref).toEqual(scenario.refs.ambiguousFace);
  const savedFingerprint = entry.target.ref.fingerprint;
  if (savedFingerprint.kind !== 'face' || chosen.fingerprint.kind !== 'face') throw new Error('Independent face fingerprints required');
  expect(Math.abs(savedFingerprint.area - 6000)).toBeLessThan(1e-6);
  expect(Math.abs(chosen.fingerprint.area - 3000)).toBeLessThan(1e-6);
  for (const [axis, coordinate] of [5, 40, 150].entries()) expect(Math.abs(chosen.fingerprint.position[axis] - coordinate)).toBeLessThan(1e-6);
  const repair = page.getByTestId('reference-repair');
  const open = async (): Promise<Locator> => {
    await expect(repair).toBeVisible();
    await repair.getByRole('button', { name: `${entry.id} / 曖昧`, exact: true }).click();
    const detail = repair.getByTestId('reference-repair-detail');
    await expect(detail).toBeVisible();
    // One click exposes the saved source, current candidates and affected use together.
    await expect(detail.getByRole('heading', { name: '元の参照（保存時の情報）', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: '現在の候補（重ねると強調）', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: '影響する寸法・合致・加工・外観', exact: true })).toBeVisible();
    await expect(detail.getByTestId('reference-repair-impacts')).toContainText(`外観: ${entry.id} / 曖昧`);
    await expect(detail).toContainText('面積 6000 mm²');
    return detail;
  };
  const choice = (detail: Locator): Locator => detail.getByRole('button')
    .filter({ hasText: '面積 3000 mm²' }).filter({ hasText: '(5, 40, 150) mm' });
  const paint = async (): Promise<void> => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const detail = await open();
  const candidate = choice(detail);
  await expect(candidate).toHaveCount(1);
  await expect(candidate).toHaveAttribute('title', 'この候補を選ぶ');
  await expect(detail.getByRole('button', { name: 'この参照で確定', exact: true })).toBeDisabled();
  await paint();
  const unhovered = await canvas(page).screenshot();
  await candidate.hover();
  await paint();
  const hovered = await canvas(page).screenshot();
  expect(hovered, '候補hoverは実viewportの描画を変える').not.toEqual(unhovered);
  await info.attach('repair-appearance-hover.png', { body: hovered, contentType: 'image/png' });
  expect(await savedPart(page, info, 'repair-appearance-hover.pcad', app)).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeDisabled();
  await candidate.click();
  await expect(candidate).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByRole('button', { name: 'この参照で確定', exact: true })).toBeEnabled();
  await detail.getByRole('button', { name: '修復を取り消す', exact: true }).click();
  await expect(repair.getByTestId('reference-repair-detail')).toHaveCount(0);
  await paint();
  expect(await canvas(page).screenshot(), '取消は候補の強調を取り除く').toEqual(unhovered);
  expect(await savedPart(page, info, 'repair-appearance-cancel.pcad', app)).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeDisabled();

  // A real unrelated shape edit advances the actual recompute generation. The
  // selected old candidate remains uncommittable; only the spare edit has history.
  const staleDetail = await open();
  await choice(staleDetail).click();
  const generation = await readRecomputeStats(page);
  await suppressSpareBox(page, fixture.spareName, 'success');
  const current = await readRecomputeStats(page);
  expect(current.completedGeneration).toBeGreaterThan(generation.completedGeneration);
  expect(current.requestedGeneration).toBe(current.completedGeneration);
  await expect(staleDetail).toContainText('文書または形が変わりました。候補を更新してください。');
  await expect(staleDetail.getByRole('button', { name: 'この参照で確定', exact: true })).toBeDisabled();
  await expect(choice(staleDetail)).toHaveCount(0);
  const suppressed = { ...baseline, solids: baseline.solids.map(solid => solid.name === fixture.spareName ? { ...solid, suppressed: true } : solid) };
  expect(await savedPart(page, info, 'repair-appearance-stale.pcad', app)).toEqual(suppressed);
  await staleDetail.getByRole('button', { name: '修復を取り消す', exact: true }).click();
  await pressHistory(page, undoButton(page), 'success');
  expect(await savedPart(page, info, 'repair-appearance-generation-undo.pcad', app)).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled();

  const finalDetail = await open();
  await choice(finalDetail).click();
  await finalDetail.getByRole('button', { name: 'この参照で確定', exact: true }).click();
  await expect(repair.getByRole('status')).toContainText('参照を修復しました。影響先を再確認します。');
  const expected = { ...baseline, appearance: { ...baseline.appearance, entries: baseline.appearance.entries.map(item => item.id === entry.id ? { ...item, target: { kind: 'face' as const, ref: chosen } } : item) } };
  const repaired = await savedPart(page, info, 'repair-appearance-confirm.pcad', app);
  expect(repaired).toEqual(expected);
  expect(repaired.appearance.entries[0].target).not.toEqual(entry.target);
  await expect(undoButton(page)).toBeEnabled();
  await expect(redoButton(page)).toBeDisabled();
  await undoButton(page).click();
  expect(await savedPart(page, info, 'repair-appearance-confirm-undo.pcad', app)).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled(); // Exactly one committed repair history.
  await expect(redoButton(page)).toBeEnabled();
  await redoButton(page).click();
  expect(await savedPart(page, info, 'repair-appearance-confirm-redo.pcad', app)).toEqual(expected);
  await expect(undoButton(page)).toBeEnabled();
  await expect(redoButton(page)).toBeDisabled();
  await saveBytes(page, info, 'repair-appearance-final.pcad', canvas(page), app);
  await reloadPage(page);
  await openAndWait(page, info.outputPath('repair-appearance-final.pcad'), 'success', app);
  await expectAppearanceRepairSaved(page);
  expect(await savedPart(page, info, 'repair-appearance-reopened.pcad', app)).toEqual(expected);
}

async function expectAppearanceRepairSaved(page: Page): Promise<void> {
  await treeRow(page, 'U字の柱').click();
  await expect(page.locator('.pcad-appearance-missing__row')).toHaveCount(1);
}

interface NativePreviewPhase {
  readonly sequence: number; readonly atMonotonicMs: number; readonly kind: string;
  readonly documentId: string; readonly generation: number; readonly operationId: string;
  readonly publicationId: string; readonly resourceOwnerId: string;
  readonly hostDisplayCopyBytes: number | null; readonly hostGpuAttributeBytes: number | null;
  readonly hostGpuReservedBytes: number | null;
}

/** Read the real metadata hook; no AppState, receipt or Source backing is installed. */
async function nativePreviewObservation(page: Page) {
  return page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadViewportMeshObservation');
    if (typeof read !== 'function') throw new Error('Actual viewport observation hook unavailable');
    const value: unknown = read();
    const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object';
    if (!object(value) || value.schemaVersion !== 1 || value.active !== true || !Array.isArray(value.events)
      || value.droppedRecords !== 0 || value.clockDiscontinuity !== false) throw new Error('Actual complete/current viewport observation required');
    const bytes = (item: unknown): number | null => {
      if (item === null) return null;
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw new Error('Invalid observed backing count');
      return item;
    };
    const events = value.events.flatMap((event: unknown) => {
      if (!object(event)) throw new Error('Malformed actual phase');
      if (event.preview !== true || typeof event.operationId !== 'string' || !event.operationId.startsWith('repair-preview-operation-')) return [];
      if (typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence)
        || typeof event.atMonotonicMs !== 'number' || !Number.isFinite(event.atMonotonicMs)
        || typeof event.kind !== 'string' || typeof event.documentId !== 'string'
        || typeof event.generation !== 'number' || !Number.isSafeInteger(event.generation)
        || typeof event.publicationId !== 'string' || typeof event.resourceOwnerId !== 'string') throw new Error('Missing actual preview owner/clock');
      return [{ sequence: event.sequence, atMonotonicMs: event.atMonotonicMs, kind: event.kind,
        documentId: event.documentId, generation: event.generation, operationId: event.operationId,
        publicationId: event.publicationId, resourceOwnerId: event.resourceOwnerId,
        hostDisplayCopyBytes: bytes(event.hostDisplayCopyBytes), hostGpuAttributeBytes: bytes(event.hostGpuAttributeBytes),
        hostGpuReservedBytes: bytes(event.hostGpuReservedBytes) }];
    });
    return { events, actualReadMonotonicMs: performance.now(), raw: JSON.stringify(value) };
  });
}

/** Cached metadata only; diagnostic failure must never replace an assertion failure. */
async function attachNativePreviewObservation(page: Page, info: TestInfo, label: string): Promise<void> {
  try {
    const observed = await nativePreviewObservation(page);
    const path = info.outputPath(`${label}-preview-events.json`);
    await writeFile(path, observed.raw, 'utf8');
    await info.attach(`${label}-preview-events.json`, { path, contentType: 'application/json' });
  } catch (error) {
    try {
      await info.attach(`${label}-preview-observation-error.json`, {
        body: Buffer.from(JSON.stringify({ error: String(error) })), contentType: 'application/json',
      });
    } catch { /* Keep the original test outcome. */ }
  }
}

/** Read the already-open Part session independently of preview publication and saved lineage ID. */
async function openedPartPreviewOwner(page: Page, generation: number): Promise<string> {
  return page.evaluate(expectedGeneration => {
    const read: unknown = Reflect.get(window, 'pcadViewportAssemblyOwner');
    if (typeof read !== 'function') throw new Error('Actual opened session observation unavailable');
    const value: unknown = read();
    if (value === null || typeof value !== 'object') throw new Error('Actual opened Part session required');
    const object: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    if (typeof object.activeDocumentId !== 'string' || object.activeDocumentId.length === 0
      || object.assemblyIdentity !== null || object.drawingIdentity !== null || object.ownership !== null
      || object.requestedGeneration !== expectedGeneration || object.completedGeneration !== expectedGeneration
      || object.recomputeCancelled !== false || object.lastOutcome !== 'failed') {
      throw new Error('Actual current Part session/generation required, without Assembly owner observation');
    }
    return object.activeDocumentId;
  }, generation);
}

/** PNG encoding changes cannot satisfy this oracle: compare decoded actual RGBA pixels. */
/** Snapshot the opened Assembly session independently of saved lineage and preview publication. */
async function openedAssemblyPreviewOwner(page: Page, generation: number) {
  return page.evaluate(expectedGeneration => {
    const read: unknown = Reflect.get(window, 'pcadViewportAssemblyOwner');
    if (typeof read !== 'function') throw new Error('Actual opened Assembly observation unavailable');
    const value: unknown = read();
    if (value === null || typeof value !== 'object') throw new Error('Actual opened Assembly session required');
    const owner: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    if (typeof owner.activeDocumentId !== 'string' || owner.activeDocumentId.length === 0
      || typeof owner.assemblyIdentity !== 'number' || !Number.isSafeInteger(owner.assemblyIdentity) || owner.assemblyIdentity <= 0
      || owner.drawingIdentity !== null || owner.requestedGeneration !== expectedGeneration
      || owner.completedGeneration !== expectedGeneration || owner.recomputeCancelled !== false
      || owner.lastOutcome !== 'failed')
      throw new Error('Actual opened Assembly session/generation required');
    return { documentId: owner.activeDocumentId, viewportOwnerId: owner.viewportOwnerId,
      assemblyIdentity: owner.assemblyIdentity, drawingIdentity: owner.drawingIdentity,
      documentVersion: owner.documentVersion, requestedGeneration: owner.requestedGeneration,
      completedGeneration: owner.completedGeneration, cancelRequestCount: owner.cancelRequestCount,
      recomputeCancelled: owner.recomputeCancelled, lastOutcome: owner.lastOutcome, timelineIndex: owner.timelineIndex,
      assemblyLibraryIdentity: owner.assemblyLibraryIdentity, assemblyViewIdentity: owner.assemblyViewIdentity,
      sourceDocumentIdentity: owner.sourceDocumentIdentity, sourceBodiesIdentity: owner.sourceBodiesIdentity,
      ownershipIdentity: owner.ownershipIdentity, ownership: owner.ownership };
  }, generation);
}

async function nativePreviewPixels(page: Page, png: Buffer) {
  const pixels = await page.evaluate(async (base64: string) => {
    const binary = atob(base64), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
      const target = new OffscreenCanvas(image.width, image.height), context = target.getContext('2d');
      if (context === null) throw new Error('Test-owned PNG decode unavailable');
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, image.width, image.height).data;
      let outlinePixels = 0, raw = '';
      for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        // Actual theme hover blue 0x8ec5ff; axes/background alone must not create an increase.
        if (b >= 90 && b > r + 20 && b > g + 10 && g > r + 10) outlinePixels += 1;
      }
      for (let start = 0; start < rgba.length; start += 8192) raw += String.fromCharCode(...rgba.subarray(start, start + 8192));
      return { width: image.width, height: image.height, outlinePixels, rgba: btoa(raw) };
    } finally { image.close(); }
  }, png.toString('base64'));
  return { ...pixels, rgba: Buffer.from(pixels.rgba, 'base64') };
}

function assertNativePublication(events: readonly NativePreviewPhase[], published: NativePreviewPhase, generation: number): void {
  expect(published.generation).toBe(generation);
  const operation = events.filter(event => event.operationId === published.operationId);
  for (const event of operation) {
    expect(event.documentId).toBe(published.documentId);
    expect(event.generation).toBe(generation);
    expect(event.publicationId).toBe(published.publicationId);
    expect(event.resourceOwnerId).toBe(published.resourceOwnerId);
  }
  const phases = ['build-start', 'build-complete', 'publish-start', 'publish-complete'].map(kind => {
    const selected = operation.filter(event => event.kind === kind);
    expect(selected, `Actual ${kind} exactly once for captured owner`).toHaveLength(1);
    return selected[0];
  });
  for (let i = 1; i < phases.length; i += 1) {
    expect(phases[i].sequence).toBeGreaterThan(phases[i - 1].sequence);
    expect(phases[i].atMonotonicMs).toBeGreaterThanOrEqual(phases[i - 1].atMonotonicMs);
  }
  expect(published.hostDisplayCopyBytes).not.toBeNull();
  expect(published.hostGpuAttributeBytes).not.toBeNull();
  expect(published.hostDisplayCopyBytes).toBeGreaterThan(0);
  expect(published.hostGpuAttributeBytes).toBeGreaterThan(0);
  expect(operation.some(event => event.kind === 'operation-aborted')).toBe(false);
}

/** Real hidden upstream Source -> captured current preview -> decoded outline/clear, separately from old R17 cases. */
export async function referenceRepairNativePreviewFlow(page: Page, info: TestInfo, use: 'part' | 'assembly',
  options: { readonly app?: ElectronApplication } = {}): Promise<void> {
  const fixture = await nativeRepairPreviewFixture(), app = options.app;
  await page.setViewportSize({ width: 1440, height: 900 });
  const extension = use === 'part' ? 'pcad' : 'pcada';
  const input = await writeFixture(info, `native-hidden-${use}.${extension}`, use === 'part' ? fixture.partBytes : fixture.assemblyBytes);
  await openAndWait(page, input, 'failed', app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', use);
  const saved = (name: string) => use === 'part' ? savedPart(page, info, `${name}.pcad`, app) : savedMates(page, info, `${name}.pcada`, app);
  const baseline = await saved(`native-${use}-baseline`);
  expect(baseline).toEqual(use === 'part' ? fixture.part : fixture.assembly);
  await expect(undoButton(page)).toBeDisabled(); await expect(redoButton(page)).toBeDisabled();
  const repair = page.getByTestId('reference-repair');
  const open = async () => {
    await expect(repair).toBeVisible();
    await repair.getByRole('button', { name: `${use === 'part' ? fixture.partSlotName : fixture.mateName} / 曖昧`, exact: true }).click();
    const detail = repair.getByTestId('reference-repair-detail'); await expect(detail).toBeVisible();
    await expect(detail.getByRole('heading', { name: '元の参照（保存時の情報）', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: '現在の候補（重ねると強調）', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: '影響する寸法・合致・加工・外観', exact: true })).toBeVisible();
    await expect(detail.getByTestId('reference-repair-impacts')).toContainText(use === 'part' ? fixture.partSlotName : fixture.mateName);
    return detail;
  };
  const choiceIndex = use === 'part' ? fixture.choiceEdgeIndex : fixture.assemblyChoiceEdgeIndex;
  const choice = (detail: Locator) => detail.getByRole('button').filter({ hasText: ` / 辺 ${String(choiceIndex)} / ` }).filter({ hasText: '長さ 10 mm' });
  const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const detail = await open(), candidate = choice(detail);
  await expect(candidate).toHaveCount(1); await expect(candidate).toHaveAttribute('title', 'この候補を選ぶ');
  await expect(detail.getByRole('button', { name: 'この参照で確定', exact: true })).toBeDisabled();
  await paint();
  const originalPNG = await canvas(page).screenshot(), original = await nativePreviewPixels(page, originalPNG);
  const before = await nativePreviewObservation(page), generation = (await readRecomputeStats(page)).completedGeneration;
  const sequence = Math.max(0, ...before.events.map(event => event.sequence));
  const openedPartOwner = use === 'part' ? await openedPartPreviewOwner(page, generation) : null;
  const openedAssemblyOwner = use === 'assembly' ? await openedAssemblyPreviewOwner(page, generation) : null;
  await candidate.hover();
  try {
    await expect.poll(async () => (await nativePreviewObservation(page)).events.filter(event => event.sequence > sequence && event.kind === 'publish-complete').length).toBe(1);
  } catch (originalError) {
    await attachNativePreviewObservation(page, info, `native-${use}-publish-failed`);
    // Failure-only metadata: existing memory getter, no new capture or retry.
    try {
      const rejection = await page.evaluate(() => {
        const read: unknown = Reflect.get(window, 'pcadViewportMemoryStats');
        if (typeof read !== 'function') return { status: 'hook-unavailable' };
        const value: unknown = read();
        if (value === null || typeof value !== 'object') return { status: 'memory-unavailable' };
        const journal: unknown = Reflect.get(value, 'repairPreviewRejections');
        if (!Array.isArray(journal)) return { status: 'journal-unavailable' };
        const reasons = journal.flatMap((entry: unknown) => {
          if (entry === null || typeof entry !== 'object') return [];
          const reason: unknown = Reflect.get(entry, 'reason');
          return typeof reason === 'string' && reason.length <= 120 ? [{ reason }] : [];
        });
        if (journal.length > 64 || reasons.length !== journal.length) return { status: 'journal-invalid' };
        return { status: 'observed', journal: reasons };
      });
      await info.attach(`native-${use}-preview-rejections.json`, {
        body: Buffer.from(JSON.stringify(rejection)), contentType: 'application/json',
      });
      const meshLedger = await page.evaluate(() => {
        const read: unknown = Reflect.get(window, 'pcadMeshLedgerDiagnostics');
        if (typeof read !== 'function') return { status: 'hook-unavailable' };
        const value: unknown = read();
        if (value === null || typeof value !== 'object') return { status: 'invalid' };
        const host: unknown = Reflect.get(value, 'host');
        const validations: unknown = Reflect.get(value, 'validations');
        if (host === null || typeof host !== 'object' || !Array.isArray(validations) || validations.length > 128)
          return { status: 'invalid' };
        const changes: unknown = Reflect.get(host, 'changes');
        if (!Array.isArray(changes) || changes.length > 128) return { status: 'invalid' };
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string' || serialized.length > 65536) return { status: 'output-cap-refused' };
        return { status: 'observed-cached-only', serialized };
      });
      await info.attach(`native-${use}-mesh-ledger.json`, {
        body: Buffer.from(JSON.stringify(meshLedger)), contentType: 'application/json',
      });
    } catch (diagnosticError) {
      try {
        await info.attach(`native-${use}-preview-rejections-error.json`, {
          body: Buffer.from(JSON.stringify({ status: 'diagnostic-failed', error: String(diagnosticError).slice(0, 1000) })),
          contentType: 'application/json',
        });
      } catch { /* Attachment failure must not replace the original assertion error. */ }
    }
    throw originalError;
  }
  const hover = await nativePreviewObservation(page);
  const published = hover.events.find(event => event.sequence > sequence && event.kind === 'publish-complete');
  if (published === undefined) throw new Error('Actual current preview publication required');
  expect(published.documentId, 'Actual opened session owner required').toBe(use === 'part' ? openedPartOwner : openedAssemblyOwner?.documentId);
  if (use === 'part') expect(await openedPartPreviewOwner(page, generation)).toBe(openedPartOwner);
  if (use === 'assembly') expect(await openedAssemblyPreviewOwner(page, generation)).toEqual(openedAssemblyOwner);
  assertNativePublication(hover.events, published, generation);
  await paint();
  const hoverPNG = await canvas(page).screenshot(), highlighted = await nativePreviewPixels(page, hoverPNG);
  expect([highlighted.width, highlighted.height]).toEqual([original.width, original.height]);
  expect(highlighted.rgba.equals(original.rgba), 'Actual decoded viewport pixels must change').toBe(false);
  expect(highlighted.outlinePixels, 'Actual hover blue pixels must increase').toBeGreaterThan(original.outlinePixels);
  await info.attach(`native-${use}-outline.png`, { body: hoverPNG, contentType: 'image/png' });
  await attachNativePreviewObservation(page, info, `native-${use}-before-hover-save`);
  try { expect(await saved(`native-${use}-hover`)).toEqual(baseline); }
  finally { await attachNativePreviewObservation(page, info, `native-${use}-after-hover-save`); }
  await expect(undoButton(page)).toBeDisabled(); await expect(redoButton(page)).toBeDisabled();
  // Actual pointer leave independently clears the separate preview owner.
  await detail.getByRole('heading', { name: '元の参照（保存時の情報）', exact: true }).hover();
  try {
    await expect.poll(async () => (await nativePreviewObservation(page)).events.filter(event => event.operationId === published.operationId && event.kind === 'release-complete').length).toBe(1);
  } finally { await attachNativePreviewObservation(page, info, `native-${use}-after-pointer-leave`); }
  const clear = await nativePreviewObservation(page), returned = clear.events.find(event => event.operationId === published.operationId && event.kind === 'release-complete');
  if (returned === undefined) throw new Error('Actual preview return required');
  expect(returned.sequence).toBeGreaterThan(published.sequence);
  expect([returned.hostDisplayCopyBytes, returned.hostGpuAttributeBytes, returned.hostGpuReservedBytes]).toEqual([0, 0, 0]);
  // A save can invalidate a proof and republish the same hovered descriptor.
  // Every actual publication must have its own owner and exactly one return.
  const publications = clear.events.filter(event => event.sequence > sequence && event.kind === 'publish-complete');
  for (const key of ['operationId', 'publicationId', 'resourceOwnerId'] as const)
    expect(new Set(publications.map(event => event[key])).size).toBe(publications.length);
  for (const publication of publications) {
    assertNativePublication(clear.events, publication, generation);
    const cycle = clear.events.filter(event => event.operationId === publication.operationId);
    expect(cycle.filter(event => event.kind === 'release-start')).toHaveLength(1);
    const terminals = cycle.filter(event => event.kind === 'release-complete' || event.kind === 'candidate-return-complete');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].kind).toBe('release-complete');
    expect(terminals[0].sequence).toBeGreaterThan(publication.sequence);
    expect([terminals[0].hostDisplayCopyBytes, terminals[0].hostGpuAttributeBytes, terminals[0].hostGpuReservedBytes]).toEqual([0, 0, 0]);
  }
  await paint(); expect((await nativePreviewPixels(page, await canvas(page).screenshot())).rgba.equals(original.rgba)).toBe(true);
  await candidate.click(); await expect(candidate).toHaveAttribute('aria-pressed', 'true');
  await detail.getByRole('button', { name: '修復を取り消す', exact: true }).click();
  await expect(repair.getByTestId('reference-repair-detail')).toHaveCount(0);
  await paint(); expect((await nativePreviewPixels(page, await canvas(page).screenshot())).rgba.equals(original.rgba)).toBe(true);
  expect(await saved(`native-${use}-cancel`)).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled(); await expect(redoButton(page)).toBeDisabled();
  // Capture a real publication-provider await window if the OS/browser exposes one.
  // Absence keeps unknown coverage; no injected delay or synthetic receipt is a late-reply proof.
  const pendingDetail = await open(), pendingChoice = choice(pendingDetail);
  const pendingBefore = await nativePreviewObservation(page), pendingSequence = Math.max(0, ...pendingBefore.events.map(event => event.sequence));
  await pendingChoice.hover();
  const pending = await nativePreviewObservation(page);
  const pendingBuild = pending.events.find(event => event.sequence > pendingSequence && event.kind === 'build-complete'
    && typeof event.hostDisplayCopyBytes === 'number' && event.hostDisplayCopyBytes > 0
    && !pending.events.some(later => later.operationId === event.operationId && ['publish-start', 'publish-complete', 'operation-aborted'].includes(later.kind)));
  // Bind the real pending state to the actual pointer-leave event caused by the
  // ordinary cancel-button click. A window that closes before this event is unknown.
  const captureKey = `pcad-e2e-pending-${pendingBuild?.operationId ?? 'none'}`;
  const pendingElement = pendingBuild === undefined ? null : await pendingChoice.elementHandle();
  if (pendingBuild !== undefined && pendingElement === null) throw new Error('Actual candidate element required before cancel');
  let pendingInstalled = false;
  let leave: { readonly awaitingPublication: boolean; readonly atMonotonicMs: number } | undefined;
  try {
    if (pendingBuild !== undefined && pendingElement !== null) {
      await pendingElement.evaluate((button, input) => {
      if (Object.hasOwn(button, input.key)) throw new Error('Test-owned pending listener collision');
      const state: { occurred: boolean; awaitingPublication: boolean; atMonotonicMs: number; error: string | null } =
        { occurred: false, awaitingPublication: false, atMonotonicMs: 0, error: null };
      const capture = (event: Event) => {
        if (!(event instanceof MouseEvent) || event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
        button.removeEventListener('mouseout', capture, true);
        state.occurred = true; state.atMonotonicMs = performance.now();
        try {
          const read: unknown = Reflect.get(window, 'pcadViewportMeshObservation');
          if (typeof read !== 'function') throw new Error('Actual pending observation unavailable');
          const value: unknown = read();
          const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object';
          if (!object(value) || value.active !== true || !Array.isArray(value.events)
            || value.droppedRecords !== 0 || value.clockDiscontinuity !== false) throw new Error('Incomplete actual pending observation');
          const actual = value.events.filter((item: unknown): item is Record<string, unknown> => object(item) && item.operationId === input.owner.operationId);
          if (!actual.every(item => item.documentId === input.owner.documentId && item.generation === input.owner.generation
            && item.resourceOwnerId === input.owner.resourceOwnerId && item.publicationId === input.owner.publicationId)) throw new Error('Actual pending owner changed');
          state.awaitingPublication = actual.some(item => item.kind === 'build-complete' && typeof item.hostDisplayCopyBytes === 'number' && item.hostDisplayCopyBytes > 0)
            && !actual.some(item => item.kind === 'publish-start' || item.kind === 'publish-complete' || item.kind === 'operation-aborted');
        } catch (error: unknown) { state.error = error instanceof Error ? error.message : String(error); }
      };
      Object.defineProperty(button, input.key, { configurable: true, value: { state,
        remove: () => { button.removeEventListener('mouseout', capture, true); Reflect.deleteProperty(button, input.key); } } });
      button.addEventListener('mouseout', capture, true);
    }, { key: captureKey, owner: pendingBuild });
      pendingInstalled = true;
    }
    // Installation evaluate has completed before ordinary input can move the pointer.
    await pendingDetail.getByRole('button', { name: '修復を取り消す', exact: true }).click();
    if (pendingInstalled && pendingElement !== null) leave = await pendingElement.evaluate((button, key) => {
      const installed: unknown = Reflect.get(button, key);
      const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object';
      if (!object(installed) || !object(installed.state)) throw new Error('Test-owned listener receipt missing');
      const state = installed.state;
      if (state.error !== null) throw new Error(typeof state.error === 'string' ? state.error : 'Malformed actual event failure');
      if (state.occurred === false) return undefined;
      if (state.occurred !== true || typeof state.awaitingPublication !== 'boolean'
        || typeof state.atMonotonicMs !== 'number' || !Number.isFinite(state.atMonotonicMs)) throw new Error('Malformed actual event receipt');
      return { awaitingPublication: state.awaitingPublication, atMonotonicMs: state.atMonotonicMs };
    }, captureKey);
  } finally {
    try {
      if (pendingInstalled && pendingElement !== null) await pendingElement.evaluate((button, key) => {
      const installed: unknown = Reflect.get(button, key);
      if (installed !== null && typeof installed === 'object') {
        const remove: unknown = Reflect.get(installed, 'remove');
        if (typeof remove !== 'function') throw new Error('Test-owned listener cleanup missing');
        remove();
      }
    }, captureKey);
    } finally { await pendingElement?.dispose(); }
  }
  let lateProviderCoverage: 'captured-real-pending-at-leave-and-rejected' | 'unknown' = 'unknown';
  if (pendingBuild !== undefined && leave?.awaitingPublication === true) {
    await expect.poll(async () => (await nativePreviewObservation(page)).events.filter(event => event.operationId === pendingBuild.operationId && event.kind === 'operation-aborted').length).toBe(1);
    const afterCancel = await nativePreviewObservation(page);
    expect(afterCancel.events.filter(event => event.operationId === pendingBuild.operationId && ['publish-start', 'publish-complete'].includes(event.kind))).toEqual([]);
    lateProviderCoverage = 'captured-real-pending-at-leave-and-rejected';
  }
  expect(await saved(`native-${use}-pending-cancel`)).toEqual(baseline);
  info.annotations.push({ type: 'R17-real-pending-provider', description: lateProviderCoverage });
  await expect(undoButton(page)).toBeDisabled(); await expect(redoButton(page)).toBeDisabled();
  const staleDetail = await open(); await choice(staleDetail).click();
  const oldGeneration = await readRecomputeStats(page);
  if (use === 'part') await suppressSpareBox(page, fixture.spareName, 'failed');
  else {
    const independent = fixture.assembly.components[1];
    if (independent === undefined) throw new Error('Actual independent component required');
    const token = await beginRecompute(page);
    await treeRow(page, independent.name).click({ button: 'right' });
    const suppress = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: uiMessage('view', 'featureTree.suppress'), exact: true });
    await expect(suppress).toBeVisible(); await suppress.click(); await waitForRecomputeOutcome(page, token, 'failed');
  }
  const current = await readRecomputeStats(page);
  expect(current.completedGeneration).toBeGreaterThan(oldGeneration.completedGeneration);
  await expect(staleDetail).toContainText('文書または形が変わりました。候補を更新してください。');
  await expect(staleDetail.getByRole('button', { name: 'この参照で確定', exact: true })).toBeDisabled();
  await expect(choice(staleDetail)).toHaveCount(0);
  const expected = use === 'part' ? { ...fixture.part, solids: fixture.part.solids.map(solid => solid.name === fixture.spareName ? { ...solid, suppressed: true } : solid) }
    : { ...fixture.assembly, components: fixture.assembly.components.map((component, index) => index === 1 ? { ...component, suppressed: true } : component) };
  expect(await saved(`native-${use}-stale`)).toEqual(expected);
  await staleDetail.getByRole('button', { name: '修復を取り消す', exact: true }).click();
  await pressHistory(page, undoButton(page), 'failed'); expect(await saved(`native-${use}-generation-undo`)).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled();
  // Confirm a freshly selected actual candidate. Expected references come from
  // the independent native generator, never the repair UI or its saved result.
  const beforeConfirm = await saved(`native-${use}-before-confirm`);
  expect(beforeConfirm).toEqual(baseline);
  const expectedConfirmed = 'sketches' in beforeConfirm
    ? { ...beforeConfirm, sketches: beforeConfirm.sketches.map(sketch => ({ ...sketch,
      features: sketch.features.map(feature => feature.id === 'hidden-source-line' && feature.kind === 'line'
        && feature.from.mode === 'relative' && feature.from.base.kind === 'subShape'
        ? { ...feature, from: { ...feature.from, base: { ...feature.from.base, ref: fixture.choiceRef } } } : feature) })) }
    : { ...beforeConfirm, mates: beforeConfirm.mates.map(mate => mate.id === 'hidden-source-mate' && mate.a.kind === 'subShape'
      ? { ...mate, a: { ...mate.a, ref: fixture.assemblyChoiceRef } } : mate) };
  expect(expectedConfirmed).not.toEqual(beforeConfirm);
  // This Assembly mate targets a Boolean-consumed body. Reference repair does
  // not make that body live: keep failed plus the specific unresolved warning.
  const confirmOutcome = use === 'part' ? 'success' : 'failed';
  const assertConfirmedAssemblyMateWarning = async (): Promise<void> => {
    if (use !== 'assembly') return;
    const warning = page.locator('.pcad-panel--left .pcad-tree__alert');
    await expect(warning).toHaveCount(1);
    await expect(warning).toHaveAttribute('title', new RegExp(MATE_TARGET_ERROR, 'u'));
  };
  const finalDetail = await open(); await choice(finalDetail).click();
  const confirmToken = await beginRecompute(page);
  await finalDetail.getByRole('button', { name: 'この参照で確定', exact: true }).click();
  await waitForRecomputeOutcome(page, confirmToken, confirmOutcome);
  await assertConfirmedAssemblyMateWarning();
  expect(await saved(`native-${use}-confirm`)).toEqual(expectedConfirmed);
  await expect(undoButton(page)).toBeEnabled(); await expect(redoButton(page)).toBeDisabled();
  await pressHistory(page, undoButton(page), 'failed');
  expect(await saved(`native-${use}-confirm-undo`)).toEqual(beforeConfirm);
  await expect(undoButton(page)).toBeDisabled(); await expect(redoButton(page)).toBeEnabled();
  await pressHistory(page, redoButton(page), confirmOutcome);
  await assertConfirmedAssemblyMateWarning();
  expect(await saved(`native-${use}-confirm-redo`)).toEqual(expectedConfirmed);
  await expect(redoButton(page)).toBeDisabled();
  await pressHistory(page, undoButton(page), 'failed');
  expect(await saved(`native-${use}-restore-before-save`)).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled();
  const finalPath = info.outputPath(`native-${use}-final.${extension}`);
  await saveBytes(page, info, `native-${use}-final.${extension}`, canvas(page), app);
  await reloadPage(page); await openAndWait(page, finalPath, 'failed', app);
  expect(await saved(`native-${use}-reopened`)).toEqual(baseline);
  const evidence = { use, nativeGenerator: fixture.nativeEvidence, actualBrowserGeneration: generation,
    phaseOwner: published, decodedPixelCounts: { before: original.outlinePixels, hover: highlighted.outlinePixels },
    lateProviderCoverage, pendingSnapshotReadMonotonicMs: pending.actualReadMonotonicMs,
    pendingCapturedOperation: pendingBuild?.operationId ?? null,
    actualPointerLeaveCapture: leave ?? null,
    browserWorkerBackingIdentityEqualsNode: 'not-established', coldThreeEnvironmentCoverage: 'unmet',
    all512MiBCoverage: 'unmet', actualDriverResidentCoverage: 'unknown', sourceNativeOwnerReleasedByPreview: 'not-performed',
    before: before.raw, hover: hover.raw, cleared: clear.raw, pending: pending.raw };
  await info.attach(`native-${use}-acceptance.json`, { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
}

/** Actual Drawing repair, with independent native expected topology and real UI edits. */
async function assertDrawingStrokePainted(page: Page, path: Locator, info: TestInfo): Promise<void> {
  const before = await path.evaluate((element) => {
    if (!(element instanceof SVGPathElement)) throw new Error('SVG path required');
    const fingerprint = (): string => JSON.stringify({ d: element.getAttribute('d'), matrix: element.getScreenCTM()?.toString(),
      root: element.ownerSVGElement?.getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight],
      ancestry: (() => { const rows: string[] = []; for (let item: Element | null = element; item !== null; item = item.parentElement) {
        const computed = getComputedStyle(item); rows.push([computed.display, computed.visibility, computed.opacity, computed.stroke,
          computed.strokeWidth, computed.strokeOpacity, computed.clipPath, computed.overflowX, computed.overflowY].join('|')); } return rows; })() });
    return fingerprint();
  });
  const png = await page.screenshot({ type: 'png', scale: 'css' });
  await info.attach('r17-current-stroke-actual-screen.png', { body: png, contentType: 'image/png' });
  const result = await path.evaluate(async (element, capture) => {
    if (!(element instanceof SVGPathElement) || !element.isConnected) throw new Error('Live SVG path required');
    const fingerprint = (): string => JSON.stringify({ d: element.getAttribute('d'), matrix: element.getScreenCTM()?.toString(),
      root: element.ownerSVGElement?.getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight],
      ancestry: (() => { const rows: string[] = []; for (let item: Element | null = element; item !== null; item = item.parentElement) {
        const computed = getComputedStyle(item); rows.push([computed.display, computed.visibility, computed.opacity, computed.stroke,
          computed.strokeWidth, computed.strokeOpacity, computed.clipPath, computed.overflowX, computed.overflowY].join('|')); } return rows; })() });
    if (fingerprint() !== capture.before) throw new Error('Stroke changed during screenshot');
    const svg = element.ownerSVGElement;
    if (svg === null || element.getTotalLength() <= 0) throw new Error('Nonempty SVG stroke required');
    const bounds = svg.getBoundingClientRect();
    const matrix = svg.getScreenCTM();
    if (matrix === null || matrix.b !== 0 || matrix.c !== 0 || !(matrix.a > 0 && matrix.d > 0)) throw new Error('Axis-aligned live SVG viewport required');
    if (!(bounds.width > 0 && bounds.height > 0) || bounds.width > 4096 || bounds.height > 4096) throw new Error('Finite SVG viewport required');
    const clips = [{ left: 0, top: 0, right: innerWidth, bottom: innerHeight }];
    for (let parent: Element | null = element; parent !== null; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) throw new Error('Hidden SVG ancestor');
      if (parent instanceof HTMLElement && [style.overflowX, style.overflowY].some((value) => ['hidden', 'clip', 'scroll', 'auto'].includes(value))) {
        const box = parent.getBoundingClientRect();
        clips.push({ left: ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX) ? box.left : 0,
          right: ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX) ? box.right : innerWidth,
          top: ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY) ? box.top : 0,
          bottom: ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY) ? box.bottom : innerHeight });
      }
    }
    const style = getComputedStyle(element);
    if (style.stroke !== 'rgb(245, 158, 11)' || !(Number.parseFloat(style.strokeWidth) > 0) || !(Number(style.strokeOpacity) > 0)) throw new Error('Actual amber stroke paint required');
    const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
    const index = originals.indexOf(element);
    const paint = async (variant: string): Promise<number> => {
      const clone = svg.cloneNode(true);
      if (!(clone instanceof SVGSVGElement)) throw new Error('SVG clone required');
      const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];
      const target = copies[index];
      if (!(target instanceof SVGPathElement)) throw new Error('Exact cloned path required');
      for (const [position, original] of originals.entries()) {
        const copy = copies[position];
        if (!(copy instanceof SVGElement)) throw new Error('SVG-only drawing required');
        const computed = getComputedStyle(original);
        for (const property of ['display', 'visibility', 'opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'fill', 'fill-opacity', 'clip-path', 'mask', 'filter']) {
          copy.style.setProperty(property, computed.getPropertyValue(property).replace(/url\(["']?[^)#]*#([^"')]+)["']?\)/gu, 'url(#$1)'));
        }
        if (original !== element && !original.contains(element) && original.closest('defs') === null) copy.style.display = 'none';
      }
      clone.setAttribute('width', String(Math.ceil(bounds.width)));
      clone.setAttribute('height', String(Math.ceil(bounds.height)));
      if (variant === 'hidden-parent') target.parentElement?.setAttribute('display', 'none');
      if (variant === 'hidden-parent') target.parentElement?.setAttribute('style', 'display:none');
      if (variant === 'transparent') target.style.opacity = '0';
      if (variant === 'zero-stroke') target.style.strokeWidth = '0';
      if (variant === 'missing-stroke') target.style.stroke = 'none';
      if (variant === 'empty-path') target.setAttribute('d', '');
      if (variant === 'clip-outside') {
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        clip.id = 'oracle-negative-clip'; clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', '1000000'); rect.setAttribute('y', '1000000'); rect.setAttribute('width', '1'); rect.setAttribute('height', '1');
        clip.append(rect); defs.append(clip); clone.append(defs); target.style.clipPath = 'url(#oracle-negative-clip)';
      }
      const image = new Image();
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
      try {
        image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(bounds.width); canvas.height = Math.ceil(bounds.height);
        const context = canvas.getContext('2d'); if (context === null) throw new Error('Raster context required');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset] < 240 || pixels[offset] > 250 || pixels[offset + 1] < 150 || pixels[offset + 1] > 165 || pixels[offset + 2] > 20 || pixels[offset + 3] === 0) continue;
          const x = bounds.left + ((offset / 4) % canvas.width + 0.5) * bounds.width / canvas.width;
          const y = bounds.top + (Math.floor(offset / 4 / canvas.width) + 0.5) * bounds.height / canvas.height;
          const top = document.elementFromPoint(x, y);
          if (top !== null && (svg.contains(top) || top.contains(svg))
            && clips.every((clip) => x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom)) count += 1;
        }
        return count;
      } finally { URL.revokeObjectURL(url); }
    };
    const actualImage = new Image();
    actualImage.src = `data:image/png;base64,${capture.png}`;
    await actualImage.decode();
    if (actualImage.width !== innerWidth || actualImage.height !== innerHeight) throw new Error('CSS-pixel viewport PNG required');
    const actualCanvas = document.createElement('canvas'); actualCanvas.width = actualImage.width; actualCanvas.height = actualImage.height;
    const actualContext = actualCanvas.getContext('2d'); if (actualContext === null) throw new Error('Actual screenshot context required');
    actualContext.drawImage(actualImage, 0, 0);
    const actualPixels = actualContext.getImageData(0, 0, actualCanvas.width, actualCanvas.height).data;
    const screen = element.getScreenCTM(); if (screen === null) throw new Error('Actual stroke transform required');
    const inverse = screen.inverse();
    const otherAmber = Array.from(document.querySelectorAll('svg path')).filter((other): other is SVGPathElement => other instanceof SVGPathElement && other !== element && getComputedStyle(other).stroke === style.stroke);
    const opaqueForeign = Array.from(document.querySelectorAll('*')).filter((other): other is HTMLElement => {
      if (!(other instanceof HTMLElement) || other.contains(svg)) return false;
      const foreignStyle = getComputedStyle(other);
      return foreignStyle.display !== 'none' && foreignStyle.visibility === 'visible' && Number(foreignStyle.opacity) > 0
        && foreignStyle.backgroundColor !== 'transparent' && foreignStyle.backgroundColor !== 'rgba(0, 0, 0, 0)';
    });
    // Amber composited over this fixture's neutral black/white drawing has channel differences
    // alpha*(245-158) and alpha*(158-11); channel rounding contributes at most one per difference.
    const actualAmber = (r: number, g: number, b: number): boolean => {
      const first = (r - g) / 87, second = (g - b) / 147;
      return first > 0 && first <= 1 && second > 0 && second <= 1
        && Math.abs(first - second) <= 1 / 87 + 1 / 147;
    };
    const pixelColorNegatives = [[0, 0, 0], [255, 255, 255], [179, 179, 179], [255, 0, 0], [0, 0, 255]]
      .map(([r, g, b]) => actualAmber(r, g, b));
    let livePixels = 0, centerPixels = 0;
    const footprintOffsets = [0.25, 0.5, 0.75];
    const belongsToCurrentStroke = (x: number, y: number): boolean => {
      if (!clips.every((clip) => x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom)) return false;
      const point = new DOMPoint(x, y);
      if (!element.isPointInStroke(point.matrixTransform(inverse)) || document.elementFromPoint(x, y) !== element) return false;
      if (otherAmber.some((other) => {
        const transform = other.getScreenCTM();
        return transform !== null && other.isPointInStroke(point.matrixTransform(transform.inverse()));
      })) return false;
      if (opaqueForeign.some((other) => {
        const rect = other.getBoundingClientRect();
        return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
      })) return false;
      return true;
    };
    for (let offset = 0; offset < actualPixels.length; offset += 4) {
      if (actualPixels[offset + 3] === 0 || !actualAmber(actualPixels[offset], actualPixels[offset + 1], actualPixels[offset + 2])) continue;
      const x = (offset / 4) % actualCanvas.width, y = Math.floor(offset / 4 / actualCanvas.width);
      const center = belongsToCurrentStroke(x + 0.5, y + 0.5);
      if (center) centerPixels += 1;
      // Antialiasing records coverage of this pixel square, not just its center.
      // Every sample stays inside this same actual amber PNG pixel and must hit the exact live path.
      if (center || footprintOffsets.some((dx) => footprintOffsets.some((dy) => belongsToCurrentStroke(x + dx, y + dy)))) livePixels += 1;
    }
    if (fingerprint() !== capture.before) throw new Error('Stroke changed during PNG inspection');

    const positive = await paint('actual');
    const negatives: Record<string, number> = {};
    for (const variant of ['hidden-parent', 'transparent', 'zero-stroke', 'missing-stroke', 'empty-path', 'clip-outside']) negatives[variant] = await paint(variant);
    return { positive, negatives, livePixels, centerPixels, pixelColorNegatives };
  }, { png: png.toString('base64'), before });
  expect(result.livePixels).toBeGreaterThan(0);
  expect(result.pixelColorNegatives).toEqual([false, false, false, false, false]);
  expect(result.positive).toBeGreaterThan(0);
  expect(result.negatives).toEqual({ 'hidden-parent': 0, transparent: 0, 'zero-stroke': 0, 'missing-stroke': 0, 'empty-path': 0, 'clip-outside': 0 });
}
export async function referenceRepairDrawingFlow(page: Page, info: TestInfo,
  options: { readonly app?: ElectronApplication } = {}) {
  const app = options.app;
  await page.setViewportSize({ width: 1440, height: 900 });
  const scenario = await buildReferenceAmbiguityScenario();
  const fixture = await referenceRepairDrawingFixture(scenario);
  const input = await writeFixture(info, 'r17-drawing-input.pcadd', fixture.bytes);
  await openAndWait(page, input, 'drawing', app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'drawing');
  const read = async (name: string) => {
    const bundle = await readDrawingBundle(await saveBytes(page, info, name, sheet(page), app));
    if (!bundle.ok) throw new Error(bundle.error.message);
    return { document: bundle.document, source: bundle.source };
  };
  const baseline = await read('r17-drawing-baseline.pcadd');
  expect(baseline.document).toEqual(fixture.document);
  expect(baseline.source.sourceKind).toBe('part');
  expect(baseline.source.document).toEqual(fixture.part);
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeDisabled();
  const repair = page.getByTestId('reference-repair');
  const projection = page.locator('[data-reference-repair-hover-status]');
  const overlay = page.locator('.pcad-drawing-svg [data-owner-id^="reference-repair-drawing:"]');
  const open = async (id: string): Promise<Locator> => {
    await expect(repair).toBeVisible();
    await repair.getByRole('button', { name: `${id} / 曖昧`, exact: true }).click();
    const detail = repair.getByTestId('reference-repair-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('heading', { name: '元の参照（保存時の情報）', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: '現在の候補（重ねると強調）', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: '影響する寸法・合致・加工・外観', exact: true })).toBeVisible();
    await expect(detail.getByTestId('reference-repair-impacts')).toContainText(id);
    return detail;
  };
  const choice = (detail: Locator): Locator => detail.getByRole('button', { name: new RegExp(` / 辺 ${String(fixture.chosen.index)} / `, 'u') });
  const unchanged = async (name: string): Promise<void> => {
    expect(await read(name)).toEqual(baseline); // Full Drawing + embedded source + actual attachments.
    await expect(undoButton(page)).toBeDisabled();
    await expect(redoButton(page)).toBeDisabled();
  };
  let detail = await open(fixture.ambiguousId); // Visible property row -> details: one operation.
  const candidate = choice(detail);
  await expect(candidate).toHaveCount(1);
  await expect(candidate).toContainText('長さ 10 mm');
  await expect(candidate).toHaveAttribute('title', 'この候補を選ぶ');
  await candidate.hover();
  await expect(projection).toHaveAttribute('data-reference-repair-hover-status', 'current');
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute('data-view-id', 'front');
  await assertDrawingStrokePainted(page, overlay.locator('[stroke="#f59e0b"]').first(), info);
  const projected = await overlay.innerHTML();
  expect(projected.length).toBeGreaterThan(0);
  await unchanged('r17-drawing-hover.pcadd');
  await detail.getByRole('heading', { name: '元の参照（保存時の情報）', exact: true }).hover();
  await expect(projection).toHaveAttribute('data-reference-repair-hover-status', 'idle');
  await expect(overlay).toHaveCount(0);
  await candidate.click();
  await expect(candidate).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByRole('button', { name: 'この参照で確定', exact: true })).toBeEnabled();
  await detail.getByRole('button', { name: '修復を取り消す', exact: true }).click();
  await expect(repair.getByTestId('reference-repair-detail')).toHaveCount(0);
  await expect(overlay).toHaveCount(0);
  await unchanged('r17-drawing-cancel.pcadd');

  // A legal surface datum reaches the genuine face-provenance refusal, not a malformed dimension.
  detail = await open(fixture.datumId);
  const face = detail.getByRole('button', { name: new RegExp(` / 面 ${String(fixture.faceChosen.index)} / `, 'u') });
  await expect(face).toContainText(`面積 ${String(fixture.faceChosen.fingerprint.kind === 'face' ? fixture.faceChosen.fingerprint.area : NaN)} mm²`);
  await expect(face).toHaveCount(1);
  await face.hover();
  await expect(projection).toHaveAttribute('data-reference-repair-hover-status', 'unavailable');
  await expect(projection).toHaveAttribute('data-reference-repair-hover-reason', 'face-provenance-unproved');
  await expect(detail.getByTestId('reference-repair-hover-unavailable')).toHaveText('この図面では面の候補を強調表示できません。面と投影線の対応を確認できないためです。');
  await expect(overlay).toHaveCount(0);
  await unchanged('r17-drawing-face-unavailable.pcadd');
  await detail.getByRole('button', { name: '修復を取り消す', exact: true }).click();

  // Genuine public view edit invalidates the old selected repair session.
  detail = await open(fixture.ambiguousId);
  await choice(detail).click();
  await page.locator('.pcad-panel--left').getByRole('button', { name: '正面図', exact: true }).click();
  const view = page.locator('[data-property-kind="view"]');
  await view.getByLabel('図の縮尺（空欄は用紙と同じ）', { exact: true }).fill('0.5');
  await view.getByRole('button', { name: '投影図の設定を適用', exact: true }).click();
  await waitForDrawingReady(page);
  await expect(detail).toContainText('文書または形が変わりました。候補を更新してください。');
  await expect(detail.getByRole('button', { name: 'この参照で確定', exact: true })).toBeDisabled();
  await expect(overlay).toHaveCount(0);
  const scaled = { ...baseline.document, views: baseline.document.views.map(item => item.id === 'front' ? { ...item, scale: 0.5 } : item) };
  expect(await read('r17-drawing-stale.pcadd')).toEqual({ ...baseline, document: scaled });
  await detail.getByRole('button', { name: '修復を取り消す', exact: true }).click();
  await undoButton(page).click(); await waitForDrawingReady(page);
  expect(await read('r17-drawing-view-undo.pcadd')).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeEnabled(); // The real view edit, and only that edit, is redoable.

  detail = await open(fixture.ambiguousId);
  await choice(detail).click();
  await detail.getByRole('button', { name: 'この参照で確定', exact: true }).click();
  await waitForDrawingReady(page);
  await expect(repair.getByRole('status')).toContainText('参照を修復しました。影響先を再確認します。');
  const expected = { ...baseline, document: { ...baseline.document, dimensions: baseline.document.dimensions.map(item => item.id === fixture.ambiguousId
    ? { ...item, targets: item.targets.map(target => target.kind === 'subShape' ? { ...target, ref: fixture.chosen } : target) } : item) } };
  expect(await read('r17-drawing-confirm.pcadd')).toEqual(expected);
  await expect(undoButton(page)).toBeEnabled();
  await expect(redoButton(page)).toBeDisabled();
  await undoButton(page).click(); await waitForDrawingReady(page);
  expect(await read('r17-drawing-confirm-undo.pcadd')).toEqual(baseline);
  await expect(undoButton(page)).toBeDisabled(); // Exactly one repair commit; prior view edit was undone.
  await expect(redoButton(page)).toBeEnabled();
  await redoButton(page).click(); await waitForDrawingReady(page);
  expect(await read('r17-drawing-confirm-redo.pcadd')).toEqual(expected);
  await expect(undoButton(page)).toBeEnabled();
  await expect(redoButton(page)).toBeDisabled();
  const path = info.outputPath('r17-drawing-final.pcadd');
  await saveBytes(page, info, 'r17-drawing-final.pcadd', sheet(page), app);
  await info.attach('r17-drawing-projection.html', { body: projected, contentType: 'text/html' });
  return { path, expected };
}

/** Called only after the first BrowserContext/Electron process has actually closed. */
export async function referenceRepairDrawingColdFlow(page: Page, info: TestInfo,
  saved: Awaited<ReturnType<typeof referenceRepairDrawingFlow>>, app?: ElectronApplication): Promise<void> {
  await openAndWait(page, saved.path, 'drawing', app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'drawing');
  const bundle = await readDrawingBundle(await saveBytes(page, info, 'r17-drawing-cold.pcadd', sheet(page), app));
  if (!bundle.ok) throw new Error(bundle.error.message);
  expect({ document: bundle.document, source: bundle.source }).toEqual(saved.expected);
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeDisabled();
  await expect(page.locator('.pcad-drawing-svg [data-owner-id^="reference-repair-drawing:"]')).toHaveCount(0);
}
