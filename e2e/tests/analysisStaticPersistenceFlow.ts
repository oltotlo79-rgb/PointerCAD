import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle, selectionKindLabel, sketchTool } from './solidCaptureSupport.js';

const FEM_WORKER = /\/fem\/worker\.js$/u;

async function openAnalysis(page: Page): Promise<Locator> {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: '現在の立体を解析', exact: true }).click();
  const panel = page.getByTestId('solid-analysis-panel');
  await expect(panel).toBeVisible();
  return panel;
}
function input(panel: Locator, name: string): Locator { return panel.getByRole('textbox', { name, exact: true }); }
async function resultValue(result: Locator, label: string): Promise<string> {
  return result.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]').innerText();
}
async function run(panel: Locator): Promise<number> {
  await panel.getByTestId('solid-run').click();
  const result = panel.getByTestId('solid-results');
  await expect(result).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expect(panel.locator(':scope > [role="alert"]')).toHaveCount(0);
  // Independent 40 x 30 mm face under -0.001 N/mm²: -1.2 N and +1.2 N reaction.
  expect(Number.parseFloat(await resultValue(result, '荷重面積'))).toBeCloseTo(1200, 6);
  expect(Number.parseFloat((await resultValue(result, '荷重合力 X, Y, Z')).split(',')[2])).toBeCloseTo(-1.2, 6);
  expect(Number.parseFloat((await resultValue(result, '支持反力の合計 X, Y, Z')).split(',')[2])).toBeCloseTo(1.2, 4);
  const displacement = Number.parseFloat(await resultValue(result, '最大変位量'));
  expect(Number.isFinite(displacement) && displacement > 0).toBe(true);
  return displacement;
}

/** Real tools, real saved file and two actual Worker runs. A page reload discards the first document/session. */
export async function analysisStaticPersistenceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  let started = 0, closed = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => {
    if (!FEM_WORKER.test(worker.url())) return;
    started += 1;
    worker.once('close', () => { closed += 1; });
  });
  const quiet = async (): Promise<void> => {
    expect(started).toBeGreaterThan(0);
    await expect.poll(() => closed, { timeout: KERNEL_TIMEOUT_MS }).toBe(started);
  };
  if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['40', '30', '10']);
  const generation = await beginRecompute(page);
  await commitPopover(page); await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, generation);
  await sketchTool(page, '選択').click(); await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  let panel = await openAnalysis(page);
  await clickWorldPoint(page, [20, 0, 0]); await panel.getByTestId('solid-fixed').click();
  await clickWorldPoint(page, [0, 0, 5]); await panel.getByTestId('solid-loaded').click();
  await expect(panel.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
  await expect(panel.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
  await input(panel, '面荷重 Z (N/mm²)').fill('-0.001');
  await input(panel, 'ヤング率 E (MPa)').fill('210000');
  await input(panel, 'ポアソン比 ν').fill('0.3');
  await input(panel, '曲面の最大体積差 (mm³)').fill('1');
  const first = await run(panel);
  await quiet();
  await panel.getByTestId('solid-save').click();
  await expect(panel.locator(':scope > [role="alert"]')).toHaveCount(0);
  await panel.getByRole('button', { name: '戻る', exact: true }).click();
  const filename = 'static-persistence.pcad';
  await saveFlowFile(page, info.outputPath(filename), app);
  // Existing helper actually reloads the editor and opens the saved bytes through the host's file gateway.
  await reopenPart(page, info, filename, app);
  panel = await openAnalysis(page);
  await expect(panel.getByTestId('solid-results')).toHaveCount(0);
  await expect(panel.getByTestId('solid-field-empty')).toBeVisible();
  await expect(panel.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
  await expect(panel.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
  await expect(input(panel, '面荷重 Z (N/mm²)')).toHaveValue('-0.001');
  await expect(input(panel, 'ヤング率 E (MPa)')).toHaveValue('210000');
  await expect(input(panel, 'ポアソン比 ν')).toHaveValue('0.3');
  await expect(input(panel, '曲面の最大体積差 (mm³)')).toHaveValue('1');
  const previousWorkers = started;
  const second = await run(panel);
  expect(started).toBeGreaterThan(previousWorkers);
  await quiet();
  // W72 uses three decimal places for its displacement ratio, avoiding an absolute zero-scale tolerance.
  expect(second / first).toBeCloseTo(1, 3);
  expect(errors).toEqual([]);
}
