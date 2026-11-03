import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle, selectionKindLabel, sketchTool } from './solidCaptureSupport.js';
import { ORBIT_RADIANS_PER_PIXEL } from '../../packages/ui/src/viewport/cameraMath.js';

async function openFinite(page: Page) {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: '大変形の弾塑性', exact: true }).click();
  const panel = page.getByTestId('solid-finite-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Rotate the actual view cube by π, then wait for the renderer; no camera state is injected. */
async function showOppositeFace(page: Page): Promise<void> {
  const cube = page.locator('canvas.pcad-viewcube'), bounds = await cube.boundingBox();
  if (bounds === null) throw new Error('View cube missing');
  const before = await page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - Math.PI / ORBIT_RADIANS_PER_PIXEL, bounds.y + bounds.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(previous => {
    const stats = window.pcadViewportRenderStats?.();
    return stats !== undefined && stats.completedRenders > previous && performance.now() - stats.lastCompletedAtMs > 350;
  }, before), { timeout: 10_000 }).toBe(true);
}

export interface SolidFiniteAuthoringHooks {
  beforeFirstResult?: (panel: Locator) => Promise<void>;
  firstResultRows?: number;
  afterFirstResult?: (panel: Locator) => Promise<void>;
  afterEdit?: () => Promise<void>;
  afterSecondResult?: (panel: Locator) => Promise<void>;
  afterClose?: () => Promise<void>;
}
export async function solidFiniteAuthoringFlow(page: Page, info: TestInfo, app?: ElectronApplication, hooks: SolidFiniteAuthoringHooks = {}): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['10', '10', '10']);
  const recompute = await beginRecompute(page); await commitPopover(page);
  await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, recompute);
  await sketchTool(page, '選択').click(); await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  const panel = await openFinite(page);
  // The home view sees +X. After a π azimuth rotation, the same home-projected pixel selects the opposite -X face.
  await clickWorldPoint(page, [5, 0, 0]); await panel.getByTestId('solid-finite-fixed').click();
  await expect(panel.getByTestId('solid-finite-fixed')).toContainText('(1)');
  await showOppositeFace(page);
  await clickWorldPoint(page, [5, 0, 0]); await panel.getByTestId('solid-finite-loaded').click();
  await expect(panel.getByTestId('solid-finite-loaded')).toContainText('(1)');
  const run = panel.getByTestId('solid-finite-run'), results = panel.getByTestId('solid-finite-results');
  await run.click(); await expect(panel.locator(':scope > [role="alert"]')).toBeVisible();
  await expect(results).toHaveCount(0);
  for (const [name, value] of [['ヤング率 E (MPa)', '200000'], ['ポアソン比 ν', '0'], ['降伏応力 (MPa)', '250'],
    ['等方硬化係数 (MPa)', '1000'], ['荷重 X (MPa)', '-50'], ['荷重 Y (MPa)', '0'], ['荷重 Z (MPa)', '0'],
    ['曲面の最大体積差 (mm³)', '0.1']] as const) await panel.getByRole('textbox', { name, exact: true }).fill(value);
  await panel.getByTestId('solid-finite-reference').fill('独立一軸弾性検証 E=200000 MPa, ν=0');
  await panel.getByTestId('solid-finite-forceFactors-0').fill('1');
  // A second unmatched row must be rejected and must never produce a result.
  await panel.getByRole('button', { name: 'ステップを追加', exact: true }).click();
  await panel.getByTestId('solid-finite-forceFactors-1').fill('2');
  await panel.getByTestId('solid-finite-prescribedFactors-0').fill('1');
  await run.click(); await expect(panel.locator(':scope > [role="alert"]')).toBeVisible(); await expect(results).toHaveCount(0);
  await panel.getByRole('button', { name: 'ステップを削除', exact: true }).nth(1).click();
  await hooks.beforeFirstResult?.(panel);
  await run.click(); await expect(results).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  const rows = results.locator('tbody tr'); await expect(rows).toHaveCount(hooks.firstResultRows ?? 1);
  const cells = rows.first().locator('td'); await expect(cells).toHaveCount(9);
  await expect(results.getByRole('columnheader', { name: '最大 Cauchy 相当応力 (MPa)', exact: true })).toBeVisible();
  await expect(results.getByRole('columnheader', { name: '最大変位 (mm)', exact: true })).toBeVisible();
  await expect(results.getByRole('columnheader', { name: '支持反力 X, Y, Z (N)', exact: true })).toBeVisible();
  expect(await cells.nth(0).innerText()).toBe('1'); expect(await cells.nth(1).innerText()).toBe('1');
  expect(await cells.nth(2).innerText()).toBe('1');
  // solidFiniteEquilibriumNative.test.ts: P=E ln(λ)/λ; E=200000 MPa, ν=0, P=50 MPa.
  // The opposite fixed face gives max |u|=10(λ-1) mm, Cauchy von Mises=50 MPa, J=λ, α=0.
  // The source affine test uses displacement 1e-9 L mm and stress 1e-8*250 MPa.
  let low = 1, high = 1.001;
  for (let i = 0; i < 60; i++) { const mid = (low + high) / 2; if (200000 * Math.log(mid) / mid < 50) low = mid; else high = mid; }
  const stretch = (low + high) / 2;
  expect(Math.abs(Number(await cells.nth(3).innerText()) - 10 * (stretch - 1))).toBeLessThanOrEqual(1e-8);
  expect(Math.abs(Number(await cells.nth(4).innerText()) - 50)).toBeLessThanOrEqual(250e-8);
  expect(Math.abs(Number(await cells.nth(5).innerText()))).toBeLessThanOrEqual(1e-10);
  expect(Math.abs(Number(await cells.nth(6).innerText()) - stretch)).toBeLessThanOrEqual(1e-10);
  expect(Number(await cells.nth(7).innerText())).toBeLessThanOrEqual(1e-8);
  const reaction = (await cells.nth(8).innerText()).split(',').map(Number);
  expect(Math.abs(reaction[0] - 5000)).toBeLessThanOrEqual(5000e-8);
  expect(Math.abs(reaction[1])).toBeLessThanOrEqual(5000e-8); expect(Math.abs(reaction[2])).toBeLessThanOrEqual(5000e-8);

  await hooks.afterFirstResult?.(panel);

  // Input edit clears old results. One save is one document history entry; Undo removes it and Redo restores it.
  await panel.getByTestId('solid-finite-forceFactors-0').fill('0.5'); await expect(results).toHaveCount(0);
  await hooks.afterEdit?.();
  await panel.getByTestId('solid-finite-save').click(); await expect(panel.locator(':scope > [role="alert"]')).toHaveCount(0);
  await page.keyboard.press('Control+z'); await expect(panel.getByTestId('solid-finite-forceFactors-0')).toHaveValue('');
  await page.keyboard.press('Control+y'); await expect(panel.getByTestId('solid-finite-forceFactors-0')).toHaveValue('0.5');
  // Close a completed result separately from the edit invalidation above; reopening must not revive it.
  await run.click(); await expect(results).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await hooks.afterSecondResult?.(panel);
  await panel.getByRole('button', { name: '戻る', exact: true }).click(); await expect(panel).toHaveCount(0);
  await hooks.afterClose?.();
  const afterClose = await openFinite(page);
  await expect(afterClose.getByTestId('solid-finite-results')).toHaveCount(0);
  await expect(afterClose.getByTestId('solid-finite-forceFactors-0')).toHaveValue('0.5');
  await afterClose.getByRole('button', { name: '戻る', exact: true }).click();
  const savedPath = info.outputPath('finite-cad-authoring.pcad');
  await saveFlowFile(page, savedPath, app); await openSaveFlowFile(page, savedPath, app);
  const reopened = await openFinite(page);
  await expect(reopened.getByTestId('solid-finite-forceFactors-0')).toHaveValue('0.5');
  await expect(reopened.getByTestId('solid-finite-prescribedFactors-0')).toHaveValue('1');
  await expect(reopened.getByRole('textbox', { name: 'ヤング率 E (MPa)', exact: true })).toHaveValue('200000');
  await expect(reopened.getByTestId('solid-finite-reference')).toHaveValue('独立一軸弾性検証 E=200000 MPa, ν=0');
  await expect(reopened.getByTestId('solid-finite-results')).toHaveCount(0);
  expect(errors).toEqual([]);
}
