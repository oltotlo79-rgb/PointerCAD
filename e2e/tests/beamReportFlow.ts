import { readFile, writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { choice } from './aluminumFrameCatalogFlow.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { cantileverStaticInputs, REPORT_EVIDENCE, savedStaticResultVersion } from './frictionFlow.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

const RESULT_TIMEOUT_MS = 120_000;

function panel(page: Page): Locator { return page.getByTestId('beam-panel'); }

/**
 * J-03c: 保存した静解析の入力を開き、確かめて実際に解析し、報告書の釦で PDF を書き出す。
 * 落とした PDF は版の頭 %PDF-1.4 と終わり %%EOF を持ち、部材 1 本(節点 2・要素 1)の報告書は 1 頁
 * (Pages の /Count 1、頁の物 1 つ)。文字は輪郭なので本文は照らさない。名前は「文書名-解析の名前.pdf」。
 * 材料・断面の出どころは、報告書の単体で 1 頁になる短い文(REPORT_EVIDENCE。frictionFlow.ts の注に製品の行番号)。
 */
export async function beamReportFlow(page: Page, pathFor: (name: string) => string): Promise<void> {
  const inputPath = pathFor('beam-report-inputs.pcada');
  await writeFile(inputPath, await cantileverStaticInputs(REPORT_EVIDENCE));
  await openSaveFlowFile(page, inputPath);
  await expect(componentRows(page)).toHaveCount(1);
  if (await page.getByTestId('beam-open').count() === 0) await chooseToolMenuItem(page, '見た目', '簡易強度計算');
  await page.getByTestId('beam-open').click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('beam-analysis-type')).toHaveValue('static');
  const report = panel(page).getByTestId('beam-report');
  await expect(report).toBeDisabled();
  const confirmation = panel(page).locator('input[data-beam-confirm]');
  await expect(confirmation).toHaveCount(1);
  await confirmation.check();
  await panel(page).getByTestId('beam-review').click();
  await expect(panel(page).getByTestId('beam-run')).toBeEnabled();
  await panel(page).getByTestId('beam-run').click();
  await expect(panel(page).getByTestId('beam-results')).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
  await expect(panel(page).getByTestId('beam-status')).toHaveAttribute('data-status', 'complete');
  await expect(report).toBeEnabled();
  const download = page.waitForEvent('download', { timeout: RESULT_TIMEOUT_MS });
  await report.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('報告書-report.pdf');
  const outputPath = pathFor('beam-report.pdf');
  await file.saveAs(outputPath);
  const text = (await readFile(outputPath)).toString('latin1');
  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.endsWith('%%EOF\n')).toBe(true);
  expect(text).toMatch(/\/Type\/Pages\/Kids\[\d+ 0 R\]\/Count 1>>/u);
  expect(text.match(/\/Type\/Page\//gu)).toHaveLength(1);
}

/** 梁の窓を開き直す(開いていれば閉じてから)。保存した入力は静解析。 */
async function reopenStaticPanel(page: Page): Promise<void> {
  if (await panel(page).count() > 0) {
    await panel(page).getByTestId('beam-close').click();
    await expect(panel(page)).toHaveCount(0);
  }
  if (await page.getByTestId('beam-open').count() === 0) await chooseToolMenuItem(page, '見た目', '簡易強度計算');
  await page.getByTestId('beam-open').click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('beam-analysis-type')).toHaveValue('static');
}

/** 選ぶ窓の「選んだ部材を書き換える」で、木で選んだ棒の長さを替える(形を変える確定。合致は無いのでそのまま入る)。 */
async function changeBarLength(page: Page, length: string): Promise<void> {
  await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.placeStandardPart'));
  const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });
  await expect(dialog).toBeVisible();
  await choice(dialog, 'assembly', 'assembly.standardPart.category').selectOption('structuralSection');
  await componentRows(page).nth(0).click();
  const bulk = dialog.locator('details').filter({
    has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.memberBulk.title') }),
  });
  await bulk.locator('summary').click();
  await expect(bulk.getByText(uiMessage('catalog', 'catalog.memberBulk.hint').replace('{count}', '1'), { exact: true })).toBeVisible();
  await bulk.locator('label.pcad-field').filter({
    has: page.locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', 'catalog.memberBulk.length') }),
  }).locator('input').fill(length);
  const token = await beginRecompute(page);
  await bulk.getByRole('button', { name: uiMessage('catalog', 'catalog.memberBulk.apply'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(bulk.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.memberBulk.applied').replace('{count}', '1'));
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * J-03b 段 1・J-03d: 保存した静解析の入力を開き、確かめて計算してから「入力を文書に反映」する(計算に使った入力のままなので結果は残る)。
 * 保存して開き直すと、流し直さずに(計算の釦は押せないまま)保存した結果の表が出る。棒の長さを 1 つ変えると、保存した結果は出なくなる。
 */
export async function savedBeamResultFlow(page: Page, pathFor: (name: string) => string): Promise<void> {
  const inputPath = pathFor('beam-saved-result-inputs.pcada');
  await writeFile(inputPath, await cantileverStaticInputs());
  await openSaveFlowFile(page, inputPath);
  await expect(componentRows(page)).toHaveCount(1);
  await reopenStaticPanel(page);
  await panel(page).locator('input[data-beam-confirm]').check();
  await panel(page).getByTestId('beam-review').click();
  await expect(panel(page).getByTestId('beam-run')).toBeEnabled();
  await panel(page).getByTestId('beam-run').click();
  await expect(panel(page).getByTestId('beam-results')).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
  await expect(panel(page).getByTestId('beam-status')).toHaveAttribute('data-status', 'complete');
  // 反映しても結果が残る事を、反映の釦の近くの 1 行で先に知らせる。
  await expect(panel(page).getByTestId('beam-apply-result-notice')).toHaveText(uiMessage('beam', 'beam.applyResultNotice'));
  await panel(page).getByTestId('beam-apply').click();
  await waitForSettledRecompute(page);
  // J-03d: 計算に使った入力のまま反映したので、結果は「反映した入力の結果」として残る(流し直さない)。
  const kept = panel(page).getByTestId('beam-saved-result');
  await expect(kept).toHaveAttribute('data-origin', 'applied');
  await expect(kept.getByRole('status')).toHaveText(uiMessage('beam', 'beam.appliedResult.status'));
  await expect(kept.getByTestId('beam-results')).toBeVisible();
  const savedPath = pathFor('beam-saved-result.pcada');
  await saveFlowFile(page, savedPath);
  const version = await savedStaticResultVersion(savedPath, 'report');
  if (version === null) throw new Error('保存した組立に静解析の結果が無い');

  await openSaveFlowFile(page, savedPath);
  await expect(componentRows(page)).toHaveCount(1);
  await reopenStaticPanel(page);
  const saved = panel(page).getByTestId('beam-saved-result');
  await expect(saved).toHaveAttribute('data-origin', 'file');
  await expect(saved.getByRole('status')).toHaveText(uiMessage('beam', 'beam.savedResult.status').replace('{version}', version));
  await expect(saved.getByTestId('beam-results')).toBeVisible();
  await expect(panel(page).getByTestId('beam-run')).toBeDisabled();

  await panel(page).getByTestId('beam-close').click();
  await expect(panel(page)).toHaveCount(0);
  await changeBarLength(page, '1500');
  await reopenStaticPanel(page);
  await expect(panel(page).getByTestId('beam-saved-result')).toHaveCount(0);
  await expect(panel(page).getByTestId('beam-results')).toHaveCount(0);
  await expect(panel(page).getByTestId('beam-saved-result-dropped')).toHaveCount(0);
}
