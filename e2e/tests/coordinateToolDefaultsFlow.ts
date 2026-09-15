import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { resolveSketch, type PartDocument } from '../../packages/model/src/index.js';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

const fields = (page: Page) => page.locator('.pcad-popover input.pcad-field__input');
const tree = (page: Page, name: string) => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });

async function openPoint(page: Page) {
  const sketch = page.getByRole('group', { name: 'スケッチ', exact: true });
  await sketch.getByRole('button', { name: '選択', exact: true }).click();
  await sketch.getByRole('button', { name: '点', exact: true }).click();
  await expect(page.locator('.pcad-popover__title')).toHaveText('点を作る');
}

async function configure(page: Page, groups: readonly { readonly mode: string; readonly values: readonly (readonly [string, string])[] }[]) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const form = page.getByRole('form', { name: '道具の初期値', exact: true });
  for (const group of groups) {
    await form.getByLabel('変更する入力', { exact: true }).selectOption({ label: `点を作る (${group.mode})` });
    for (const [name, source] of group.values) await form.getByRole('textbox', { name, exact: true }).fill(source);
  }
  await form.getByRole('button', { name: '初期値を適用', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
}

async function commit(page: Page, name: string) {
  const token = await beginRecompute(page);
  await fields(page).first().press('Enter'); await waitForRecompute(page, token);
  await expect(tree(page, name)).toBeVisible();
}

function verify(document: PartDocument, expected: readonly (readonly number[])[]) {
  const sketch = document.sketches[0], resolved = resolveSketch(sketch);
  expect(resolved.errors).toEqual([]);
  const points = sketch.features.filter(feature => feature.kind === 'point');
  expect(points).toHaveLength(expected.length);
  for (const [index, feature] of points.entries()) {
    const position = resolved.points.find(point => point.id === feature.id)?.position;
    if (position === undefined) throw new Error(`保存した点がありません: ${feature.name}`);
    for (let axis = 0; axis < 3; axis += 1) expect(position[axis]).toBeCloseTo(expected[index][axis], 9);
  }
  return points;
}

/** 座標モードの設定、連続入力の写し、式、実座標を同じ保存ファイルで照合する。 */
export async function coordinateToolDefaultsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);
  const original = await savePart(page, info, 'coordinate-defaults-original.pcad', app);
  await configure(page, [
    { mode: '絶対', values: [['X (mm)', '10'], ['Y (mm)', '20'], ['Z (mm)', '0']] },
    { mode: '相対', values: [['ΔX (mm)', '30'], ['ΔY (mm)', '40'], ['ΔZ (mm)', '0']] },
    { mode: '極', values: [['距離 (mm)', '50'], ['角度 (°)', 'rad(pi/2)'], ['仰角 (°)', '0']] },
  ]);
  expect(await savePart(page, info, 'coordinate-defaults-settings-only.pcad', app)).toEqual(original);
  await openPoint(page);
  await expect(fields(page).first()).toHaveValue('10'); await fields(page).first().fill('11');
  await configure(page, [
    { mode: '絶対', values: [['X (mm)', '99']] }, { mode: '相対', values: [['ΔX (mm)', '300']] },
    { mode: '極', values: [['距離 (mm)', '500']] },
  ]);
  await expect(fields(page).first()).toHaveValue('11'); await commit(page, '点1');
  await expect(fields(page).first()).toHaveValue('10');
  await fields(page).first().press('Alt+2');
  for (const [index, source] of ['30', '40', '0'].entries()) await expect(fields(page).nth(index)).toHaveValue(source);
  await commit(page, '点2'); await fields(page).first().press('Alt+3');
  for (const [index, source] of ['50', 'rad(pi/2)', '0'].entries()) await expect(fields(page).nth(index)).toHaveValue(source);
  await page.screenshot({ path: info.outputPath('coordinate-defaults-polar-input.png') });
  await commit(page, '点3'); await fields(page).first().press('Escape');
  const created = await savePart(page, info, 'coordinate-defaults-created.pcad', app);
  const points = verify(created, [[11, 20, 0], [41, 60, 0], [41, 110, 0]]);
  expect(points.map(point => point.at.mode)).toEqual(['absolute', 'relative', 'polar']);
  expect(points[0].at).toMatchObject({ x: { source: '11' }, y: { source: '20' }, z: { source: '0' } });
  expect(points[1].at).toMatchObject({ base: { kind: 'previous' }, dx: { source: '30' }, dy: { source: '40' } });
  expect(points[2].at).toMatchObject({ base: { kind: 'previous' }, distance: { source: '50' }, azimuth: { source: 'rad(pi/2)', value: 90 } });

  const undo = await beginRecompute(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForRecompute(page, undo);
  verify(await savePart(page, info, 'coordinate-defaults-undone.pcad', app), [[11, 20, 0], [41, 60, 0]]);
  await openPoint(page); await expect(fields(page).first()).toHaveValue('99');
  await fields(page).first().press('Alt+2'); await expect(fields(page).first()).toHaveValue('300');
  await fields(page).first().press('Alt+3'); await expect(fields(page).first()).toHaveValue('500');
  await fields(page).first().press('Alt+1'); await expect(fields(page).first()).toHaveValue('99');
  await fields(page).first().press('Escape');

  await page.reload(); await waitForStartupHealth(page, info);
  const path = info.outputPath('coordinate-defaults-created.pcad');
  const token = await beginRecompute(page);
  if (app === undefined) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '開く', exact: true }).click()]);
    await chooser.setFiles(path);
  } else { await openTarget(app, path); await page.getByRole('button', { name: '開く', exact: true }).click(); }
  await waitForRecompute(page, token); await expect(tree(page, '点3')).toBeVisible();
  expect(await savePart(page, info, 'coordinate-defaults-reopened.pcad', app)).toEqual(created);
}
