import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { create, field, openDefaults, settingsButton } from './sheetToolDefaultsFlow.js';
import { chooseSheet, command, rectangleFace, tree, volume } from './sheetUiFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

export async function setDefaults(page: Page, values: readonly (readonly [string, string])[]): Promise<void> {
  const form = await openDefaults(page);
  for (const [name, value] of values) await field(form, name).fill(value);
  await form.getByRole('button', { name: '初期値を適用', exact: true }).click();
  await settingsButton(page).click();
}

export async function reopen(page: Page, info: TestInfo, file: string, app?: ElectronApplication): Promise<void> {
  await page.reload(); await waitForStartupHealth(page, info);
  const path = info.outputPath(file);
  if (app !== undefined) await openTarget(app, path);
  const token = await beginRecompute(page);
  if (app === undefined) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '開く', exact: true }).click()]);
    await chooser.setFiles(path);
  } else await page.getByRole('button', { name: '開く', exact: true }).click();
  await waitForRecompute(page, token);
}

async function basePlate(page: Page): Promise<void> {
  await rectangleFace(page);
  await tree(page, '面1').click(); await chooseSheet(page, '板金基板');
  await create(page, page.getByRole('form', { name: '板金基板', exact: true }), '板金基板1');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
}

/** A separate real line-bend flow keeps its cancellation, geometry and file checks bounded. */
export async function sheetBendDefaultsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);
  await setDefaults(page, [['板厚', '2'], ['内半径', '3'], ['K係数', '0.4'], ['曲げ角', '-45*2']]);
  await basePlate(page);
  await command(page, 'L'); await command(page, '0,15'); await command(page, '@50,0');
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Escape');
  await tree(page, '線分1').click();
  const original = await savePart(page, info, 'bend-defaults-original.pcad', app);
  await chooseSheet(page, '指定線で曲げる');
  const bend = page.getByRole('form', { name: '指定線で曲げる', exact: true });
  await expect(field(bend, '曲げ角')).toHaveValue('-45*2');
  await setDefaults(page, [['曲げ角', '-30']]);
  await expect(field(bend, '曲げ角')).toHaveValue('-45*2');
  await bend.getByRole('button', { name: '取消', exact: true }).click();
  expect(await savePart(page, info, 'bend-defaults-cancelled.pcad', app)).toEqual(original);

  await chooseSheet(page, '指定線で曲げる');
  await expect(field(bend, '曲げ角')).toHaveValue('-30');
  const radius = bend.getByRole('checkbox', { name: 'この曲げの内半径を指定', exact: true });
  const k = bend.getByRole('checkbox', { name: 'この曲げのK係数を指定', exact: true });
  await expect(radius).not.toBeChecked(); await expect(k).not.toBeChecked();
  await radius.check(); await k.check();
  await expect(field(bend, '内半径')).toHaveValue('3'); await expect(field(bend, 'K係数')).toHaveValue('0.4');
  await radius.uncheck(); await k.uncheck();
  await create(page, bend, '指定線で曲げる1');
  // A 50 × 30 × 2 plate with R=3, K=.4 gains 50*2*(1-.8)*pi/6 in its bend band.
  const bentVolume = 3000 + 10 * Math.PI / 3;
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(bentVolume, 4);
  const created = await savePart(page, info, 'bend-defaults-created.pcad', app);
  expect(created.solids.find(item => item.kind === 'sheetBend')).toMatchObject({
    angle: { source: '-30', value: -30 }, rule: { innerRadius: null, kFactor: null },
  });

  await setDefaults(page, [['曲げ角', '60']]);
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  await expect(field(bend, '曲げ角')).toHaveValue('-30');
  await bend.getByRole('button', { name: '取消', exact: true }).click();
  await reopen(page, info, 'bend-defaults-created.pcad', app);
  expect(await savePart(page, info, 'bend-defaults-reopened.pcad', app)).toEqual(created);
  await tree(page, '指定線で曲げる1').click();
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  await expect(field(bend, '曲げ角')).toHaveValue('-30');
  await field(bend, '曲げ角').fill('-45');
  await bend.getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(bend).toHaveCount(0);
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 5 * Math.PI, 4);
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z'); await waitForRecompute(page, undo);
  expect(await savePart(page, info, 'bend-defaults-undone.pcad', app)).toEqual(created);
  await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  expect(Number((await unfold.getByRole('status').textContent())?.match(/体積: ([\d.]+)/u)?.[1])).toBeCloseTo(3000, 4);
}

/** Use a flat rectangular cut so an independent width × depth × thickness checks the configured shape. */
export async function sheetReliefDefaultsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);
  await setDefaults(page, [['板厚', '2'], ['内半径', '3'], ['入口の中心位置', '5'], ['切欠きの幅', '2*2'], ['切欠きの深さ', '3*2']]);
  await basePlate(page);
  const original = await savePart(page, info, 'relief-defaults-original.pcad', app);
  await chooseSheet(page, '曲げリリーフ');
  const relief = page.getByRole('form', { name: '曲げリリーフ', exact: true });
  for (const [name, value] of [['入口の中心位置', '5'], ['切欠きの幅', '2*2'], ['切欠きの深さ', '3*2']]) {
    await expect(field(relief, name)).toHaveValue(value);
  }
  await relief.getByRole('combobox', { name: '切欠きの入口の縁', exact: true }).selectOption({ label: 'パネル 1 / 縁 1' });
  await relief.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(relief.getByRole('status')).toContainText('体積:', { timeout: 60_000 });
  await relief.getByRole('button', { name: '取消', exact: true }).click();
  expect(await savePart(page, info, 'relief-defaults-cancelled.pcad', app)).toEqual(original);
  await chooseSheet(page, '曲げリリーフ');
  await relief.getByRole('combobox', { name: '切欠きの入口の縁', exact: true }).selectOption({ label: 'パネル 1 / 縁 1' });
  await create(page, relief, '曲げリリーフ1');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 - 4 * 6 * 2, 4);
  const created = await savePart(page, info, 'relief-defaults-created.pcad', app);
  expect(created.solids.find(item => item.kind === 'sheetRelief')).toMatchObject({
    shape: 'rectangle', position: { source: '5', value: 5 }, width: { source: '2*2', value: 4 }, depth: { source: '3*2', value: 6 },
  });
  await setDefaults(page, [['切欠きの幅', '10']]);
  await reopen(page, info, 'relief-defaults-created.pcad', app);
  expect(await savePart(page, info, 'relief-defaults-reopened.pcad', app)).toEqual(created);
  await tree(page, '曲げリリーフ1').click();
  await page.getByRole('button', { name: '板金の参照と条件を編集', exact: true }).click();
  await expect(field(relief, '切欠きの幅')).toHaveValue('2*2');
  await expect(field(relief, '切欠きの深さ')).toHaveValue('3*2');
  await field(relief, '切欠きの深さ').fill('7');
  await relief.getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(relief).toHaveCount(0);
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 - 4 * 7 * 2, 4);
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z'); await waitForRecompute(page, undo);
  expect(await savePart(page, info, 'relief-defaults-undone.pcad', app)).toEqual(created);
}
