import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { absoluteCoordinate, appendFeature, createEmptyPartDocument, createPointFeature, nextFeatureId, nextFeatureName,
  replaceSketch, type PartDocument } from '../../packages/model/src/index.js';
import { readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { savePart } from './scriptsFlow.js';
import { tree } from './sheetUiFlow.js';
import { uiMessage } from './uiMessages.js';

const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');
const undoButton = (page: Page) => page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true });
const fileLabel = (page: Page) => page.locator('.pcad-statusbar__file');
const radialMenu = (page: Page) => page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
const FILE_MENU = uiMessage('toolbar', 'toolbar.fileMenu.groupLabel');

/** 点3つの部品。`withLine` なら線分1も持つ。点の id は A/B で同じ(別の文書の同名 id)。 */
function partWith(name: string, positions: readonly (readonly [number, number, number])[], withLine: boolean): PartDocument {
  let sketch = createEmptyPartDocument().sketches[0];
  for (const position of positions) sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(...position), 'xy'));
  if (withLine) {
    sketch = appendFeature(sketch, { id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'), kind: 'line',
      planeId: 'xy', from: absoluteCoordinate(40, -20, 0), to: absoluteCoordinate(70, -20, 0), construction: false });
  }
  return { ...replaceSketch(createEmptyPartDocument(), sketch), name };
}

/** Ctrl+O で開く(Electron は実デスクトップの開く窓、Web はファイルの選択)。計算の成功まで待つ。 */
async function openWithKey(page: Page, path: string, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page); await page.keyboard.press('Control+o');
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecompute(page, token);
}

/** 「ファイルのほかの操作」の最近使ったファイルの行から開く(開く窓を出すところまでが製品の動き)。 */
async function openRecent(page: Page, name: string, path: string, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) await openTarget(app, path);
  await openToolMenu(page, FILE_MENU);
  const row = toolMenuPanel(page, FILE_MENU).getByRole('button', { name, exact: true });
  await expect(row, `最近使ったファイルに「${name}」があること`).toBeVisible();
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page); await row.click();
  if (chooser !== undefined) await (await chooser).setFiles(path);
  await waitForRecompute(page, token);
}

/** 開いた直後の約束: 元に戻すは押せず、Ctrl+Z でも計算も文書も変わらず、前の文書の選択は空。 */
async function expectFreshHistory(page: Page, label: string, unselected: readonly string[]): Promise<void> {
  await expect(fileLabel(page)).toHaveText(label);
  await expect(undoButton(page)).toBeDisabled();
  for (const name of unselected) await expect(tree(page, name)).toHaveAttribute('aria-pressed', 'false');
  const before = await readRecomputeStats(page);
  await canvas(page).focus(); await page.keyboard.press('Control+z');
  await expect(fileLabel(page)).toHaveText(label);
  await expect(undoButton(page)).toBeDisabled();
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(before.requestedGeneration);
}

/** Web はダウンロード、Electron は開いたファイルへの上書き(保存先を聞かない)。保存した中身を返す。 */
async function overwriteWithKey(page: Page, info: TestInfo, openedPath: string, app?: ElectronApplication): Promise<PartDocument> {
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await canvas(page).focus(); await expect(canvas(page)).toBeFocused();
  if (app !== undefined) {
    const original = await readFile(openedPath);
    await page.keyboard.press('Control+s');
    // 上書きの完了は、開いたファイルのバイト列が保存し直した内容へ変わることで待つ。
    await expect.poll(async () => Buffer.compare(await readFile(openedPath), original) !== 0).toBe(true);
    const read = readPcadFile(new Uint8Array(await readFile(openedPath)));
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    return read.document;
  }
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const path = info.outputPath('history-overwrite.pcad'); await (await download).saveAs(path);
  const read = readPcadFile(new Uint8Array(await readFile(path)));
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.document;
}

/**
 * 別の文書を開いた後の「元に戻す」と選択(2026-10-05 の不具合の直し)。
 *
 * 1. 部品A(点3つと線分1)を開き、線分1を消して保存する。元に戻すは押せる。点1・点2を選ぶ。
 * 2. Ctrl+O で、同じ id の点を持つ部品Bを開く。元に戻すは押せず、Ctrl+Z でもBのまま(計算も起きない)。
 *    点1・点2は選ばれておらず、右クリックの一覧(Shift+F10)は点の操作を出さない。
 * 3. 上書き保存(Ctrl+S)は、開いたBのファイルへBの中身を書く(前の文書Aの中身で壊さない)。
 * 4. 点1を選んでから、最近使ったファイルの行でAのファイルを開く。線分1のある元のAが出て、
 *    元に戻すは押せず、Ctrl+Z でもAのまま、点1は選ばれていない。
 */
export async function openDocumentHistoryFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const a = partWith('A', [[0, 0, 0], [30, 20, 0], [60, 0, 0]], true);
  const b = partWith('B', [[5, 5, 0], [25, 5, 0], [5, 25, 0]], false);
  const aPath = info.outputPath('history-A.pcad'), bPath = info.outputPath('history-B.pcad');
  await writeFile(aPath, writePcadFile(a), { flag: 'wx' });
  await writeFile(bPath, writePcadFile(b), { flag: 'wx' });

  // 1. Aを開き、線分1を消して(履歴が1段できる)保存し、点1・点2を選ぶ。
  await reopenPart(page, info, 'history-A.pcad', app);
  await expect(tree(page, '線分1')).toBeVisible();
  await tree(page, '線分1').click({ button: 'right' });
  const removing = await beginRecompute(page);
  await page.getByRole('menuitem', { name: uiMessage('view', 'featureTree.delete'), exact: true }).click();
  await waitForRecompute(page, removing);
  await expect(tree(page, '線分1')).toHaveCount(0);
  await expect(undoButton(page)).toBeEnabled();
  expect((await savePart(page, info, 'history-A-edited.pcad', app)).name).toBe('A');
  await tree(page, '点1').click(); await tree(page, '点2').click({ modifiers: ['Control'] });
  await expect(tree(page, '点1')).toHaveAttribute('aria-pressed', 'true');
  await expect(tree(page, '点2')).toHaveAttribute('aria-pressed', 'true');
  await expect(undoButton(page)).toBeEnabled();

  // 2. Ctrl+O で B を開く。新しい履歴から始まり、前の文書の選択は空。
  await openWithKey(page, bPath, app);
  await expectFreshHistory(page, 'history-B.pcad', ['点1', '点2', '点3']);
  await canvas(page).focus(); await page.keyboard.press('Shift+F10');
  await expect(radialMenu(page).getByRole('menuitem').first()).toBeFocused();
  await expect(radialMenu(page).getByRole('menuitem')).toHaveCount(8);
  await expect(radialMenu(page).locator('[data-command-id="sketch.connectPoints"]')).toHaveCount(0);
  await expect(radialMenu(page).locator('[data-command-id="sketch.faceFromPoints"]')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(radialMenu(page)).toHaveCount(0);

  // 3. Ctrl+Z の後の上書き保存は、開いた B のファイルへ B の中身を書く(名前を付けて保存の前に行う)。
  const overwritten = await overwriteWithKey(page, info, bPath, app);
  expect(overwritten.name).toBe('B'); expect(overwritten.sketches).toEqual(b.sketches);
  await expect(fileLabel(page)).toHaveText('history-B.pcad');

  // 4. 最近使ったファイルの行から A を開いても同じ約束。
  await tree(page, '点1').click();
  await expect(tree(page, '点1')).toHaveAttribute('aria-pressed', 'true');
  await openRecent(page, 'history-A.pcad', aPath, app);
  await expect(tree(page, '線分1')).toBeVisible();
  await expectFreshHistory(page, 'history-A.pcad', ['点1']);
  const reopened = await savePart(page, info, 'history-A-reopened.pcad', app);
  expect(reopened.name).toBe('A'); expect(reopened.sketches).toEqual(a.sketches);
}
