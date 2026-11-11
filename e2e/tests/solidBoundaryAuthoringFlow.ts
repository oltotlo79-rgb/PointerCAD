import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle,
  selectionKindLabel, sketchTool, type WorldPoint } from './solidCaptureSupport.js';
import { solidResultCsvFlow } from './solidResultCsvFlow.js';

const AXES = ['x', 'y', 'z'] as const;
const LABELS = ['指定変位 X (mm)', '指定変位 Y (mm)', '指定変位 Z (mm)'] as const;
const FACE_CENTERS: readonly WorldPoint[] = [[20, 0, 0], [0, -15, 0], [0, 0, 5]];

async function openAnalysis(page: Page): Promise<Locator> {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: '現在の立体を解析', exact: true }).click();
  const panel = page.getByTestId('solid-analysis-panel');
  await expect(panel).toBeVisible();
  return panel;
}

function supportValue(panel: Locator, index: number): Locator {
  return panel.getByTestId(`solid-support-${index}`).getByRole('textbox', { name: LABELS[index], exact: true });
}

export async function solidBoundaryAuthoringFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  // The actual box tool creates 40 × 30 × 10 mm, centred at the origin; no store/native-result injection.
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['40', '30', '10']);
  const recompute = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, recompute);
  await sketchTool(page, '選択').click();
  await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');

  const panel = await openAnalysis(page);
  for (const [index, face] of FACE_CENTERS.entries()) {
    await clickWorldPoint(page, face);
    if (index === 0) {
      // Converting a legacy full clamp removes it atomically, leaving one editable support.
      await panel.getByTestId('solid-fixed').click();
      await panel.getByTestId('solid-clamp-convert-0').click();
      await expect(panel.getByTestId('solid-clamp-0')).toHaveCount(0);
    } else await panel.getByTestId('solid-support-add').click();
    for (const axis of AXES) {
      if (axis !== AXES[index]) await panel.getByTestId(`solid-support-${index}-${axis}-fixed`).uncheck();
    }
    await supportValue(panel, index).fill(index === 0 ? '0.1 mm' : '0');
  }
  await expect(panel.getByTestId('solid-fixed')).toHaveText('選択面を固定 (0)');
  await expect(panel.getByTestId('solid-support-3')).toHaveCount(0);
  await panel.getByTestId('solid-gravity-enabled').check();
  const gravity = panel.getByTestId('solid-gravity');
  const density = gravity.getByRole('textbox', { name: '密度 (kg/m³)', exact: true });
  await expect(density).toHaveCount(1);
  await expect(density).toHaveValue('');
  await expect(panel.getByTestId('solid-run')).toBeDisabled();
  await density.fill('7800');
  await gravity.getByRole('textbox', { name: '加速度 Z (m/s²)', exact: true }).fill('-9.81 m/s²');
  await panel.getByRole('textbox', { name: 'ヤング率 E (MPa)', exact: true }).fill('210000');
  await panel.getByRole('textbox', { name: 'ポアソン比 ν', exact: true }).fill('0.3');
  await panel.getByRole('textbox', { name: '曲面の最大体積差 (mm³)', exact: true }).fill('1');
  await panel.getByTestId('solid-save').click();
  await expect(panel.locator(':scope > [role="alert"]')).toHaveCount(0);

  // A saved physical edit, Undo and Redo restore the authored conditions, not an unrelated session draft.
  await supportValue(panel, 0).fill('0.2');
  await panel.getByTestId('solid-save').click();
  await page.keyboard.press('Control+z');
  await expect(supportValue(panel, 0)).toHaveValue('0.1');
  await page.keyboard.press('Control+y');
  await expect(supportValue(panel, 0)).toHaveValue('0.2');
  await panel.getByRole('button', { name: '戻る', exact: true }).click();
  const savedPath = info.outputPath('solid-three-supports-gravity.pcad');
  await saveFlowFile(page, savedPath, app);
  await openSaveFlowFile(page, savedPath, app);
  await openAnalysis(page);
  for (const [index, axis] of AXES.entries()) {
    await expect(panel.getByTestId(`solid-support-${index}-${axis}-fixed`)).toBeChecked();
    await expect(supportValue(panel, index)).toHaveValue(index === 0 ? '0.2' : '0');
    for (const other of AXES.filter(value => value !== axis)) {
      await expect(panel.getByTestId(`solid-support-${index}-${other}-fixed`)).not.toBeChecked();
      await expect(panel.getByTestId(`solid-support-${index}-${other}-free`)).toHaveText('この方向は自由');
    }
  }
  await expect(panel.getByTestId('solid-gravity-enabled')).toBeChecked();
  await expect(density).toHaveValue('7800');
  await expect(gravity.getByRole('textbox', { name: '加速度 Z (m/s²)', exact: true })).toHaveValue('-9.81');
  await expect(panel.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (0)');

  const calculationStarted = Date.now();
  await panel.getByTestId('solid-run').click();
  const result = panel.getByTestId('solid-results');
  // Includes the first offline WASM load, as in the existing preload flow.
  // Use the common finite kernel wait; the default assertion wait is not a performance requirement.
  await expect(result).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await info.attach('solid-boundary-calculation-time', { contentType: 'application/json',
    body: JSON.stringify({ elapsedMs: Date.now() - calculationStarted, includesFirstRuntimeLoad: true }) });
  // Independent oracle: 12000 mm³ × 1e-9 m³/mm³ × 7800 kg/m³ × -9.81 m/s² = -0.918216 N.
  const total = await result.getByText('荷重合力 X, Y, Z', { exact: true }).locator('xpath=following-sibling::dd[1]').innerText();
  const reaction = await result.getByText('支持反力の合計 X, Y, Z', { exact: true }).locator('xpath=following-sibling::dd[1]').innerText();
  expect(Number.parseFloat(total.split(',')[2])).toBeCloseTo(-0.918216, 6);
  expect(Number.parseFloat(reaction.split(',')[2])).toBeCloseTo(0.918216, 4);
  await expect(panel.locator(':scope > [role="alert"]')).toHaveCount(0);
  // The same native result leaves through the panel's CSV button and the real save path; the bytes are checked.
  await solidResultCsvFlow(page, result, info, app);

  // Removing two directions must invalidate the old result and report the actual rigid-body failure.
  await panel.getByTestId('solid-support-remove-2').click();
  await panel.getByTestId('solid-support-remove-1').click();
  await expect(result).toHaveCount(0);
  await panel.getByTestId('solid-run').click();
  await expect(panel.locator(':scope > [role="alert"]')).toContainText('立体全体が移動または回転できる固定条件です');
  await expect(result).toHaveCount(0);

  await panel.getByTestId('solid-modal-density').fill('7800');
  await panel.getByTestId('solid-modal-count').fill('3');
  await panel.getByTestId('solid-modal-run').click();
  await expect(panel.getByTestId('solid-modal-error')).toContainText('現在の固有振動解析へ渡せません');
  await panel.getByTestId('solid-buckling-count').fill('1');
  await panel.getByTestId('solid-buckling-run').click();
  await expect(panel.getByTestId('solid-buckling-error')).toContainText('重力を含む条件の座屈解析は未対応です');
  await expect(supportValue(panel, 0)).toHaveValue('0.2');
  await expect(density).toHaveValue('7800');
  expect(errors).toEqual([]);
}
