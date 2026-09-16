import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { PartDocument } from '../../packages/model/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

function circleRadiusSources(document: PartDocument): string[] {
  return document.sketches.flatMap(sketch => sketch.features)
    .flatMap(feature => feature.kind === 'arc' && feature.startAngle.value === 0 && feature.endAngle.value === 360
      ? [feature.radius.source] : []);
}

export async function openCircle(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  await chooseToolMenuItem(page, '作図', '円');
  await expect(page.locator('.pcad-popover__title')).toHaveText('円の中心');
}

export async function enterCenter(page: Page, x: string): Promise<void> {
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (const [index, value] of [x, '0', '0'].entries()) await fields.nth(index).fill(value);
  await fields.first().press('Enter');
  await expect(page.locator('.pcad-popover__title')).toHaveText('円の半径');
}

export async function commitCircle(page: Page): Promise<void> {
  const recompute = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, recompute);
  await page.keyboard.press('Escape');
}

async function openCircleDefault(page: Page): Promise<Locator> {
  const settingsButton = page.getByRole('button', { name: '設定', exact: true });
  await settingsButton.click();
  const form = page.getByRole('form', { name: '道具の初期値', exact: true });
  await form.getByLabel('変更する入力', { exact: true }).selectOption({ label: '円の半径' });
  return form.getByLabel('半径 (mm)', { exact: true });
}

/** Chromium・Firefox・Electronで同じ操作を通すP12-8の共通台本。 */
export async function toolDefaultsSettingsFlow(page: Page, info: TestInfo,
  app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 変更前から存在する円は、設定適用・保存・再計算で変わらない。
  await openCircle(page); await enterCenter(page, '0'); await commitCircle(page);
  const before = await savePart(page, info, 'tool-defaults-before.pcad', app);
  expect(circleRadiusSources(before)).toEqual(['10']);
  const generation = (await readRecomputeStats(page)).requestedGeneration;

  const radius = await openCircleDefault(page);
  const form = page.getByRole('form', { name: '道具の初期値', exact: true });
  const apply = form.getByRole('button', { name: '初期値を適用', exact: true });
  await expect(radius).toHaveValue('10');
  await radius.fill('0'); await expect(radius).toHaveAttribute('aria-invalid', 'true');
  await expect(apply).toBeDisabled();
  await form.getByRole('button', { name: '初期値の変更を取り消す', exact: true }).click();
  await expect(radius).toHaveValue('10');
  await radius.fill('12.5'); await apply.click();
  await captureManualDetail(page, info, { name: 'tool-defaults-radius', dialog: form,
    fixture: { document: before, radiusSource: '12.5' }, script: new URL(import.meta.url) });
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '150');
  await radius.fill('13'); await expect(apply).toBeEnabled();
  await form.getByRole('button', { name: '初期値の変更を取り消す', exact: true }).click();
  await expect(radius).toHaveValue('12.5');
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '100%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
  expect(await savePart(page, info, 'tool-defaults-settings-only.pcad', app)).toEqual(before);

  // 道具の開始後に設定を変えても、その入力の後段は開始時の写し(12.5)を使う。
  await openCircle(page);
  const changedRadius = await openCircleDefault(page);
  await changedRadius.fill('20'); await apply.click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await enterCenter(page, '30');
  await expect(page.locator('.pcad-popover input.pcad-field__input').first()).toHaveValue('12.5');
  await commitCircle(page);

  // 次に開く道具から20を使い、Undoは直前に作った円だけを除く。
  await openCircle(page); await enterCenter(page, '60');
  await expect(page.locator('.pcad-popover input.pcad-field__input').first()).toHaveValue('20');
  await commitCircle(page);
  const created = await savePart(page, info, 'tool-defaults-created.pcad', app);
  expect(circleRadiusSources(created)).toEqual(['10', '12.5', '20']);
  const undo = await beginRecompute(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForRecompute(page, undo);
  expect(circleRadiusSources(await savePart(page, info, 'tool-defaults-undone.pcad', app))).toEqual(['10', '12.5']);

  // 端末設定は再読込後も残り、F1は同じ設定の説明へ開く。
  await page.reload(); await waitForStartupHealth(page, info);
  const persisted = await openCircleDefault(page); await expect(persisted).toHaveValue('20');
  await persisted.focus(); await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('道具の初期値を変える');
  await page.keyboard.press('Escape'); await expect(form).toBeVisible();
}
