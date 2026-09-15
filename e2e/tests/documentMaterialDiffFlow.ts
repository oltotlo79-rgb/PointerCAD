import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { expressionValueFromNumber as value } from '../../packages/expression/src/index.js';
import { absoluteCoordinate, createEmptyPartDocument, createPrimitiveFeature, type BooleanFeature, type PrimitiveFeature } from '../../packages/model/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { openTarget } from './electronAppFlow.js';
import { savePart } from './scriptsFlow.js';
import { captureManualDetail } from './captureManualDetail.js';

async function selectFile(page: Page, button: Locator, path: string, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) { await openTarget(app, path); await button.click(); }
  else { const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]); await chooser.setFiles(path); }
}

export async function documentMaterialDiffFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '作る', '箱');
  const created = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter'); await waitForRecompute(page, created);
  const baseline = await savePart(page, info, 'material-current-before.pcad', app);
  const generation = (await readRecomputeStats(page)).requestedGeneration;
  const empty = { ...createEmptyPartDocument(), name: '穴開けを比較する部品' };
  const box: PrimitiveFeature = { ...createPrimitiveFeature(empty, 'box'), id: 'base', name: '台座',
    shape: { kind: 'box', sizeX: value(20), sizeY: value(20), sizeZ: value(20) } };
  const cylinder: PrimitiveFeature = { ...createPrimitiveFeature(empty, 'cylinder'), id: 'tool', name: '直径6の穴の工具',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, -11) },
    shape: { kind: 'cylinder', radius: value(3), height: value(22) } };
  const cut: BooleanFeature = { id: 'cut', name: '貫通穴', kind: 'boolean', suppressed: false,
    operation: 'subtract', targetFeatureId: box.id, toolFeatureId: cylinder.id };
  const before = { ...empty, solids: [box] }, after = { ...empty, solids: [box, cylinder, cut] };
  const beforeBytes = writePcadFile(before), afterBytes = writePcadFile(after);
  const beforePath = info.outputPath('穴開け前.pcad'), afterPath = info.outputPath('穴開け後.pcad');
  await writeFile(beforePath, beforeBytes, { flag: 'wx' }); await writeFile(afterPath, afterBytes, { flag: 'wx' });
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '2つの保存ファイルを比較');
  const dialog = page.getByRole('dialog', { name: '2つの保存ファイルを比較', exact: true });
  await selectFile(page, dialog.getByRole('button', { name: '変更前のファイルを選ぶ', exact: true }), beforePath, app);
  await selectFile(page, dialog.getByRole('button', { name: '変更後のファイルを選ぶ', exact: true }), afterPath, app);
  await dialog.getByLabel('2つのファイルの関係', { exact: true }).selectOption('versions');
  await dialog.getByRole('button', { name: '変更を比較する', exact: true }).click();
  const definitions = dialog.getByRole('region', { name: '比較結果', exact: true });
  await expect(definitions.locator('[data-diff-status="added"]')).toHaveCount(2);
  const panel = dialog.getByRole('region', { name: '立体の形の比較', exact: true });
  const start = panel.getByRole('button', { name: '立体の形を比較する', exact: true });
  // 実Workerの初回読込み中に中止する。前に完了した定義比較はそのまま残る。
  await start.click(); await panel.getByRole('button', { name: '形の比較を中止', exact: true }).click();
  await expect(start).toBeEnabled(); await expect(panel.getByRole('status')).toContainText('中止');
  await expect(definitions.locator('[data-diff-status="added"]')).toHaveCount(2);
  await start.click();
  const volume = (name: string) => panel.locator(`[data-material-volume="${name}"]`);
  await expect(volume('removed')).toBeVisible({ timeout: 90_000 });
  const removed = Number(await volume('removed').getAttribute('data-value'));
  // 元の設計寸法から独立に πr²h を計算し、工具全長22ではなく板厚20だけを数える。
  expect(removed).toBeCloseTo(Math.PI * 3 ** 2 * 20, 6);
  expect(Number(await volume('added').getAttribute('data-value'))).toBe(0);
  expect(Number(await volume('before').getAttribute('data-value'))).toBeCloseTo(8000, 6);
  expect(Number(await volume('after').getAttribute('data-value'))).toBeCloseTo(8000 - removed, 6);
  expect(Number(await volume('common').getAttribute('data-value'))).toBeCloseTo(8000 - removed, 6);
  const preview = panel.getByLabel('追加・削除・共通部分の3D表示', { exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-material-ready', 'true');
  await panel.getByRole('button', { name: '削除した材料（橙）', exact: true }).click();
  await expect(preview).toHaveAttribute('data-material-selection', 'removed');
  await expect(preview).toHaveAttribute('data-material-ready', 'true');
  await expect(panel.getByRole('button', { name: '削除した材料（橙）', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const fixture = { kind: 'twenty-mm-box-through-six-mm-hole', before, after, expectedRemoved: Math.PI * 9 * 20 };
  const summary = panel.locator('.pcad-material-diff__summary'); await summary.scrollIntoViewIfNeeded();
  await captureManualDetail(page, info, { name: 'document-material-diff-summary', dialog: summary, script: new URL(import.meta.url), fixture });
  const figure = panel.locator('figure'); await figure.scrollIntoViewIfNeeded();
  await captureManualDetail(page, info, { name: 'document-material-diff-preview', dialog: figure, script: new URL(import.meta.url), fixture });
  await panel.getByRole('button', { name: '全ての材料を表示', exact: true }).click();
  await expect(preview).toHaveAttribute('data-material-selection', 'all');
  const interrupted = await preview.evaluate(element => {
    if (!(element instanceof HTMLCanvasElement)) return false;
    const extension = element.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (extension === null || extension === undefined) return false;
    extension.loseContext(); return true;
  });
  expect(interrupted).toBe(true);
  await expect(preview).toHaveAttribute('data-material-ready', 'false');
  expect(Number(await volume('removed').getAttribute('data-value'))).toBe(removed);
  await panel.getByRole('button', { name: '比較の3D表示を再試行', exact: true }).click();
  await expect(preview).toHaveAttribute('data-material-ready', 'true');
  expect(Number(await volume('removed').getAttribute('data-value'))).toBe(removed);
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('削除した材料');
  await page.keyboard.press('Escape'); await expect(panel).toBeVisible();
  await dialog.getByRole('button', { name: '比較を閉じる', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
  expect(await savePart(page, info, 'material-current-after.pcad', app)).toEqual(baseline);
  expect(new Uint8Array(await readFile(beforePath))).toEqual(beforeBytes); expect(new Uint8Array(await readFile(afterPath))).toEqual(afterBytes);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true })).toHaveCount(0);
}
