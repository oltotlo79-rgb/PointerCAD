import { expect, test, type Page } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { parseDxfTags, readDxf, readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { sheetFlatDrawingFlow } from './sheetDrawingFlow.js';
import { sheetExportFlow, verifySheetStepFiles } from './sheetExportFlow.js';
import { sheetHelpFlow } from './sheetHelpFlow.js';
import { withBrowserFailureDiagnostics } from './browserFailureDiagnostics.js';
import { captureManualDetail } from './captureManualDetail.js';

import { tree, command, chooseSheet, volume, rectangleFace } from './sheetUiFlow.js';
import { addFlangeToConvertedPlate, convertExtrudedPlate, openConvertTool, undoRedoConvert, unfoldConvertedFlange, unfoldConvertedPlate } from './sheetConvertFlow.js';

import { clickWorldPoint } from './homeViewProjection.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { sheetHolePartFile } from './sheetHoleFixture.js';
import { openSheetPart } from './sheetPartFlow.js';

async function useBrowserFileEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
}

const fileAction = (page: Page, name: string) => page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name, exact: true });

test('P10 板金の指定線曲げを作成・取消・再展開・保存往復し、式編集とUndoを通す', async ({ page }, testInfo) => {
  await withBrowserFailureDiagnostics(page, testInfo, async stage => {
  stage('起動と板金基板の作成');
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
  await page.goto('/'); await rectangleFace(page);
  await tree(page, '面1').click(); await chooseSheet(page, '板金基板');
  const base = page.getByRole('form', { name: '板金基板', exact: true });
  await base.getByRole('textbox', { name: /^板厚/ }).fill('2');
  await base.getByRole('textbox', { name: /^内半径/ }).fill('3');
  await base.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, '板金基板1')).toBeVisible(); await tree(page, '板金基板1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
  stage('指定線曲げの試し表示・取消・作成');
  await command(page, 'L'); await command(page, '0,15'); await command(page, '@50,0');
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Escape');
  await expect(tree(page, '線分1')).toBeVisible(); await tree(page, '線分1').click();
  await chooseSheet(page, '指定線で曲げる');
  const form = page.getByRole('form', { name: '指定線で曲げる', exact: true });
  await form.getByRole('textbox', { name: /^曲げ角/ }).fill('180');
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await expect(form.getByRole('textbox', { name: /^曲げ角/ })).toHaveAttribute('aria-invalid', 'true');
  await form.getByRole('textbox', { name: /^曲げ角/ }).fill('-45*2');
  await form.getByRole('combobox', { name: '固定する側', exact: true }).selectOption('left');
  await sheetHelpFlow(page, '指定線で板を曲げる・曲げリリーフを作る', testInfo, 'sheet-line-help.png');
  await form.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('体積:', { timeout: 60_000 });
  await captureManualDetail(page, testInfo, { name: 'sheet-line-preview', dialog: form, fixture: { step: 'preview' }, script: new URL(import.meta.url) });
  await expect(tree(page, '指定線で曲げる1')).toHaveCount(0);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await tree(page, '板金基板1').click(); await expect.poll(() => volume(page)).toBeCloseTo(3000, 5);
  await chooseSheet(page, '指定線で曲げる');
  await form.getByRole('textbox', { name: /^曲げ角/ }).fill('-45*2');
  await form.getByRole('combobox', { name: '固定する側', exact: true }).selectOption('left');
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, '指定線で曲げる1')).toBeVisible(); await tree(page, '指定線で曲げる1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 10 * Math.PI, 4);
  await captureManualDetail(page, testInfo, { name: 'sheet-line-created', dialog: page.locator('.pcad-panel--right'),
    fixture: { step: 'created' }, script: new URL(import.meta.url) });
  stage('板金の展開');
  await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('combobox', { name: '固定面', exact: true }).selectOption({ label: 'パネル 2' });
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  await expect.poll(async () => Number(await unfold.getByRole('status').getAttribute('title')), { timeout: 60_000 }).toBeCloseTo(3000, 4);
  await page.screenshot({ path: testInfo.outputPath('sheet-line-flat.png') });
  stage('展開後の文書を保存');
  const [downloaded] = await Promise.all([page.waitForEvent('download'), fileAction(page, '保存').click()]);
  const savedPath = testInfo.outputPath('sheet-line.pcad'); await downloaded.saveAs(savedPath);
  const decoded = readPcadFile(await readFile(savedPath)); if (!decoded.ok) throw new Error(decoded.error.message);
  expect(decoded.document.solids[1]).toMatchObject({ kind: 'sheetBend', fixedSide: 'left', angle: { source: '-45*2', value: -90 } });
  stage('保存した文書を開き直す');
  await fileAction(page, '新規').click();
  const chooser = page.waitForEvent('filechooser'); await fileAction(page, '開く').click(); await (await chooser).setFiles(savedPath);
  await expect(tree(page, '指定線で曲げる1')).toBeVisible(); await tree(page, '指定線で曲げる1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 10 * Math.PI, 4);
  const angle = page.locator('.pcad-panel--right .pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: /^曲げ角$/ }) }).locator('input');
  stage('曲げ角の再編集とUndo');
  await expect(angle).toHaveValue('-45*2'); await angle.fill('-45'); await angle.press('Tab');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 5 * Math.PI, 4);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z'); await expect(angle).toHaveValue('-45*2');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 + 10 * Math.PI, 4);
  expect(errors).toEqual([]);
  });
});

test('P10 板金基板とフランジを画面で作り、保存往復・式編集・Undoを通す', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  // ダウンロードとinput[type=file]の経路を明示する。ネイティブpickerはElectronの別検査で通す。
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
  await page.goto('/'); await rectangleFace(page);
  await tree(page, '面1').click(); await chooseSheet(page, '板金基板');
  const base = page.getByRole('form', { name: '板金基板', exact: true });
  await base.getByRole('textbox', { name: /^板厚/ }).fill('2mm');
  await base.getByRole('textbox', { name: /^内半径/ }).fill('3mm');
  await base.getByRole('textbox', { name: /^K係数/ }).fill('0.4');
  // 説明書には操作可能な状態を撮る。初回OCCT読込中の画面を採用しない。
  await expect(base.getByRole('button', { name: '作成', exact: true })).toBeEnabled({ timeout: 60_000 });
  await captureManualDetail(page, testInfo, { name: 'sheet-base-input', dialog: base, fixture: { step: 'base-input' }, script: new URL(import.meta.url) });
  await sheetHelpFlow(page, '板金の基板と曲げ条件を作る', testInfo, 'sheet-base-help.png');
  await base.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, '板金基板1')).toBeVisible(); await tree(page, '板金基板1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
  await chooseSheet(page, 'フランジ');
  const flange = page.getByRole('form', { name: 'フランジ', exact: true });
  await flange.getByRole('checkbox', { name: 'パネル 1 / 縁 1', exact: true }).check();
  await flange.getByRole('textbox', { name: /^フランジの長さ/ }).fill('0');
  await flange.getByRole('button', { name: '作成', exact: true }).click();
  await expect(flange.getByRole('textbox', { name: /^フランジの長さ/ })).toHaveAttribute('aria-invalid', 'true');
  await expect(tree(page, 'フランジ1')).toHaveCount(0);
  await flange.getByRole('textbox', { name: /^フランジの長さ/ }).fill('10*2');
  const converted = flange.locator('dl[aria-label="曲げ寸法の換算"]');
  const straight = converted.locator('dt').filter({ hasText: /^接線からの直線長$/ }).locator('xpath=following-sibling::dd[1]');
  // 曲げの寸法の文字は有効 6 桁、全部の桁は title(UI の点検の指摘 26)。
  await expect(converted.locator('dd[title="5.96902604182 mm"]')).toHaveCount(1);
  await flange.getByRole('combobox', { name: '長さの基準', exact: true }).selectOption('outer');
  await expect(straight).toHaveText('15 mm');
  await flange.getByRole('combobox', { name: '長さの基準', exact: true }).selectOption('inner');
  await expect(straight).toHaveText('17 mm');
  await flange.getByRole('combobox', { name: '長さの基準', exact: true }).selectOption('tangent');
  await expect(straight).toHaveText('20 mm');
  await sheetHelpFlow(page, '板金の縁からフランジを作る', testInfo, 'sheet-flange-help.png');
  await flange.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(flange.getByRole('status')).toContainText('体積:', { timeout: 60_000 });
  await expect(tree(page, 'フランジ1')).toHaveCount(0);
  await captureManualDetail(page, testInfo, { name: 'sheet-flange-preview', dialog: flange, fixture: { step: 'preview' }, script: new URL(import.meta.url) });
  await flange.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, 'フランジ1')).toBeVisible(); await tree(page, 'フランジ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 200 * Math.PI, 4);
  await page.screenshot({ path: testInfo.outputPath('sheet-flange-created.png') });

  await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('combobox', { name: '固定面', exact: true }).selectOption({ label: 'パネル 2' });
  const fixedPanelId = await unfold.getByRole('combobox', { name: '固定面', exact: true }).inputValue();
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  await expect.poll(async () => Number(await unfold.getByRole('status').getAttribute('title')), { timeout: 60_000 }).toBeCloseTo(5000 + 190 * Math.PI, 4);
  await captureManualDetail(page, testInfo, { name: 'sheet-unfold', dialog: unfold, fixture: { fixedPanelId }, script: new URL(import.meta.url) });
  await unfold.getByRole('button', { name: '折曲げを表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toHaveCount(0);
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });

  const downloaded = page.waitForEvent('download'); await fileAction(page, '保存').click();
  const savedPath = testInfo.outputPath('sheet-flange.pcad'); await (await downloaded).saveAs(savedPath);
  // 一時通知はhover案内で変わるため、保存した実ファイルと後続の読込結果を検査する。
  expect((await stat(savedPath)).size).toBeGreaterThan(0);
  const decoded = readPcadFile(await readFile(savedPath)); if (!decoded.ok) throw new Error(decoded.error.message);
  expect(decoded.document.sheetUnfolds).toEqual([{ sourceFeatureId: decoded.document.solids[1].id, fixedPanelId, seamConnectionIds: [] }]);
  expect(JSON.stringify(decoded.document.sheetUnfolds)).not.toMatch(/mesh|displayMode|flatCoordinates/u);
  await fileAction(page, '新規').click(); await expect(tree(page, 'フランジ1')).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser'); await fileAction(page, '開く').click(); await (await chooser).setFiles(savedPath);
  await expect(tree(page, 'フランジ1')).toBeVisible(); await tree(page, 'フランジ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 200 * Math.PI, 4);
  await chooseSheet(page, '板金の展開');
  await expect(unfold.getByRole('combobox', { name: '固定面', exact: true })).toHaveValue(fixedPanelId);
  await expect(unfold.getByRole('status')).toHaveCount(0);
  await unfold.getByRole('button', { name: '閉じる', exact: true }).click();
  await tree(page, 'フランジ1').click();
  const length = page.locator('.pcad-panel--right .pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: /^フランジの長さ$/ }) }).locator('input');
  await expect(length).toHaveValue('10*2'); await length.fill('25'); await length.press('Tab');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5500 + 200 * Math.PI, 4);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await expect(length).toHaveValue('10*2');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 200 * Math.PI, 4);
  expect(errors).toEqual([]);
});

test('P10 板金の曲げ帯をまたぐ長穴リリーフを作成し、展開・保存・再編集・Undoする', async ({ page }, testInfo) => withBrowserFailureDiagnostics(page, testInfo, async (stage) => {
  stage('板金基板と曲げた板の作成');
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
  await page.goto('/'); await rectangleFace(page);
  await tree(page, '面1').click(); await chooseSheet(page, '板金基板');
  const base = page.getByRole('form', { name: '板金基板', exact: true });
  await base.getByRole('textbox', { name: /^板厚/ }).fill('2');
  await base.getByRole('textbox', { name: /^内半径/ }).fill('3');
  await base.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, '板金基板1')).toBeVisible(); await tree(page, '板金基板1').click();
  await chooseSheet(page, 'フランジ');
  const flange = page.getByRole('form', { name: 'フランジ', exact: true });
  await flange.getByRole('checkbox', { name: 'パネル 1 / 縁 1', exact: true }).check();
  await flange.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, 'フランジ1')).toBeVisible(); await tree(page, 'フランジ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 200 * Math.PI, 4);
  await chooseSheet(page, '曲げリリーフ');
  stage('切欠きの試し表示と作成');
  const relief = page.getByRole('form', { name: '曲げリリーフ', exact: true });
  await relief.getByRole('combobox', { name: '切欠きの入口の縁', exact: true }).selectOption({ label: 'パネル 1 / 縁 1' });
  await relief.getByRole('combobox', { name: '切欠きの形', exact: true }).selectOption('slot');
  await relief.getByRole('textbox', { name: /^切欠きの幅/ }).fill('2*2');
  await relief.getByRole('textbox', { name: /^切欠きの深さ/ }).fill('1');
  await relief.getByRole('button', { name: '作成', exact: true }).click();
  await expect(relief.getByRole('alert')).toContainText('幅の半分');
  await expect(tree(page, '曲げリリーフ1')).toHaveCount(0);
  await relief.getByRole('textbox', { name: /^切欠きの深さ/ }).fill('5');
  await relief.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(relief.getByRole('status')).toContainText('体積:', { timeout: 60_000 });
  await captureManualDetail(page, testInfo, { name: 'sheet-relief-preview', dialog: relief, fixture: { step: 'preview' }, script: new URL(import.meta.url) });
  await relief.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, '曲げリリーフ1')).toBeVisible(); await tree(page, '曲げリリーフ1').click();
  const foldedVolume = 5000 + 200 * Math.PI - 78 * (6 + Math.PI) / 19;
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(foldedVolume, 4);
  await page.screenshot({ path: testInfo.outputPath('sheet-relief-created.png') });
  stage('切欠きのある板をパネル2から展開');
  await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('combobox', { name: '固定面', exact: true }).selectOption({ label: 'パネル 2' });
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  await expect.poll(async () => Number(await unfold.getByRole('status').getAttribute('title')), { timeout: 60_000 }).toBeCloseTo(4976 + 186 * Math.PI, 4);
  await page.screenshot({ path: testInfo.outputPath('sheet-relief-flat.png') });
  stage('保存した板金の再読込');
  const downloaded = page.waitForEvent('download'); await fileAction(page, '保存').click();
  const savedPath = testInfo.outputPath('sheet-relief.pcad'); await (await downloaded).saveAs(savedPath);
  const decoded = readPcadFile(await readFile(savedPath)); if (!decoded.ok) throw new Error(decoded.error.message);
  expect(decoded.document.solids[2]).toMatchObject({ kind: 'sheetRelief', shape: 'slot', position: { value: 0 }, width: { source: '2*2', value: 4 }, depth: { value: 5 } });
  await fileAction(page, '新規').click();
  const chooser = page.waitForEvent('filechooser'); await fileAction(page, '開く').click(); await (await chooser).setFiles(savedPath);
  await expect(tree(page, '曲げリリーフ1')).toBeVisible(); await tree(page, '曲げリリーフ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(foldedVolume, 4);
  const depth = page.locator('.pcad-panel--right .pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: /^切欠きの深さ$/ }) }).locator('input');
  await expect(depth).toHaveValue('5'); await depth.fill('6'); await depth.press('Tab');
  stage('切欠きと曲げ条件の再編集と取消');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(foldedVolume - 312 / 38, 4);
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z'); await expect(depth).toHaveValue('5');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(foldedVolume, 4);
  // 元のフランジはリリーフへ消費されている。編集は元IDのまま後続まで再計算する。
  const editButton = page.locator('.pcad-panel--right').getByRole('button', { name: '板金の参照と条件を編集', exact: true });
  await tree(page, 'フランジ1').click(); await editButton.click();
  const editingFlange = page.getByRole('form', { name: 'フランジ', exact: true });
  await expect(editingFlange.getByRole('checkbox', { name: 'パネル 1 / 縁 1', exact: true })).toBeChecked();
  await editingFlange.getByRole('checkbox', { name: 'この曲げの内半径を指定', exact: true }).check();
  await editingFlange.getByRole('checkbox', { name: 'この曲げのK係数を指定', exact: true }).check();
  await editingFlange.getByRole('textbox', { name: /^内半径/ }).fill('4');
  await editingFlange.getByRole('textbox', { name: /^K係数/ }).fill('0.3');
  await editingFlange.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(editingFlange.getByRole('status')).toContainText('合計体積:', { timeout: 60_000 });
  await captureManualDetail(page, testInfo, { name: 'sheet-edit-flange-preview', dialog: editingFlange, fixture: { step: 'edit-preview' }, script: new URL(import.meta.url) });
  await editingFlange.getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(editingFlange).toHaveCount(0); await tree(page, '曲げリリーフ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 250 * Math.PI - 96 * (6 + Math.PI) / 23, 4);
  await expect(tree(page, 'フランジ2')).toHaveCount(0); await expect(tree(page, '曲げリリーフ2')).toHaveCount(0);
  await tree(page, 'フランジ1').click(); await editButton.click();
  await expect(editingFlange.getByRole('textbox', { name: /^内半径/ })).toHaveValue('4');
  await editingFlange.getByRole('checkbox', { name: 'この曲げの内半径を指定', exact: true }).uncheck();
  await editingFlange.getByRole('checkbox', { name: 'この曲げのK係数を指定', exact: true }).uncheck();
  await expect(editingFlange.getByRole('textbox', { name: /^内半径/ })).toHaveCount(0);
  await editingFlange.getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(editingFlange).toHaveCount(0); await tree(page, '曲げリリーフ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(foldedVolume, 4);
  await tree(page, 'フランジ1').click(); await editButton.click();
  await editingFlange.getByRole('checkbox', { name: 'パネル 1 / 縁 1', exact: true }).uncheck();
  await editingFlange.getByRole('checkbox', { name: 'パネル 1 / 縁 3', exact: true }).check();
  await editingFlange.getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(editingFlange).toHaveCount(0); await tree(page, '曲げリリーフ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(4988 + 198 * Math.PI, 4);
  await captureManualDetail(page, testInfo, { name: 'sheet-edit-reference', dialog: page.locator('.pcad-panel--right'),
    fixture: { step: 'edit-reference' }, script: new URL(import.meta.url) });
  await page.locator('canvas.pcad-viewport__canvas').press('Control+z');
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(foldedVolume, 4);
  await chooseSheet(page, '板金の展開');
  stage('再編集後の展開とファイルへの出力');
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  const exports = await sheetExportFlow(page, testInfo);
  await sheetFlatDrawingFlow(page, testInfo, savedPath);
  await verifySheetStepFiles(page, savedPath, exports);

  expect(errors).toEqual([]);
}));

test('M-08 押し出した板を板金へ変え、取り消し・やり直し・展開の後、フランジを足して展開DXFと保存・開き直しまで同じ形になる', async ({ page }, testInfo) => withBrowserFailureDiagnostics(page, testInfo, async (stage) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await useBrowserFileEvents(page);
  stage('板を作って板金へ変える');
  await convertExtrudedPlate(page);
  stage('取り消すと元の押し出しに戻り、やり直すと変換が戻る');
  await undoRedoConvert(page);
  stage('変換した板金を展開する');
  await unfoldConvertedPlate(page);
  stage('変換した板金にフランジを足す');
  await addFlangeToConvertedPlate(page);
  stage('フランジを足した板金を展開し、展開DXFを書き出す');
  await unfoldConvertedFlange(page);
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  const dxfPath = testInfo.outputPath('sheet-convert-flat.dxf');
  const dxfDownload = page.waitForEvent('download');
  await unfold.getByRole('button', { name: '展開DXF', exact: true }).click();
  await (await dxfDownload).saveAs(dxfPath);
  const dxf = readDxf(parseDxfTags(await readFile(dxfPath, 'utf8')));
  expect(dxf.unit).toBe('mm');
  // 切断の外形は 50 × (30 + 1.9π + 20)。曲げは +90 度なので BEND_UP の線だけ(flatBendLines.ts の direction)。
  const points = dxf.entities.filter((entity) => entity.layer === 'CUT_OUTER').flatMap((entity) => entity.kind === 'line' ? [entity.start, entity.end] : []);
  const size = (axis: 'x' | 'y'): number => Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis]));
  const [short, long] = [size('x'), size('y')].sort((a, b) => a - b);
  expect(short).toBeCloseTo(50, 4);
  expect(long).toBeCloseTo(50 + 1.9 * Math.PI, 4);
  expect(dxf.entities.filter((entity) => entity.layer === 'BEND_UP').length).toBeGreaterThan(0);
  expect(dxf.entities.some((entity) => entity.layer === 'BEND_DOWN')).toBe(false);
  stage('保存して開き直すと、変換とフランジを同じ形で再計算する');
  const downloaded = page.waitForEvent('download'); await fileAction(page, '保存').click();
  const savedPath = testInfo.outputPath('sheet-convert.pcad'); await (await downloaded).saveAs(savedPath);
  const decoded = readPcadFile(await readFile(savedPath)); if (!decoded.ok) throw new Error(decoded.error.message);
  expect(decoded.document.schemaVersion).toBe(24);
  expect(decoded.document.solids.map((feature) => feature.kind)).toEqual(['extrude', 'sheetConvert', 'sheetFlange']);
  await fileAction(page, '新規').click(); await expect(tree(page, 'フランジ1')).toHaveCount(0);
  const reopen = await beginRecompute(page);
  const chooser = page.waitForEvent('filechooser'); await fileAction(page, '開く').click(); await (await chooser).setFiles(savedPath);
  await waitForRecompute(page, reopen);
  await expect(tree(page, 'フランジ1')).toBeVisible({ timeout: 60_000 }); await tree(page, 'フランジ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 200 * Math.PI, 4);
  expect(errors).toEqual([]);
}));

/** 既存の穴表のスケッチを使い、認識前の立体だけを作る。形状と穴の表は Worker が計算する。 */
function sheetConvertSourceFile(blind: boolean): Uint8Array {
  const seed = readPcadFile(sheetHolePartFile());
  if (!seed.ok) throw new Error(seed.error.message);
  const sketch = seed.document.sketches[0];
  const profile = { sketchId: sketch.id, faceFeatureId: 'outer' };
  const n = (value: number) => ({ value, source: String(value), display: String(value) });
  const base = { kind: 'extrude', id: 'solid-1', name: '押し出し1', suppressed: false, profile,
    distance: n(2), reversed: false, symmetric: false } as const;
  if (blind) {
    const bore = { ...base, id: 'solid-2', name: '押し出し2', profile: { ...profile, faceFeatureId: 'hole-1' }, distance: n(1) };
    const cut = { kind: 'boolean', id: 'solid-3', name: '差1', suppressed: false, operation: 'subtract',
      targetFeatureId: base.id, toolFeatureId: bore.id } as const;
    return writePcadFile({ ...seed.document, solids: [base, bore, cut] });
  }
  const circles = sketch.features.filter((feature) => feature.kind === 'arc');
  const outerFace = sketch.features.find((feature) => feature.id === profile.faceFeatureId);
  if (circles.length !== 2 || outerFace?.kind !== 'face') throw new Error('外周面と二つの円が必要です');
  const holedSketch = { ...sketch, features: [
    ...sketch.features.filter((feature) => feature.id !== outerFace.id),
    // 面を解く時点で、穴の境界となる円が履歴に積まれている必要がある。
    { ...outerFace, holes: circles.map(({ id }) => [{ featureId: id }]) },
  ] };
  return writePcadFile({ ...seed.document, schemaVersion: 23, sketches: [holedSketch], solids: [base] });
}

test('M-08 二つの貫通穴を持つ立体を板金へ変え、展開図に径4の穴表を配置する', async ({ page }, testInfo) => withBrowserFailureDiagnostics(page, testInfo, async (stage) => {
  await useBrowserFileEvents(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  stage('押し出しの立体と基準面を選び、二つの穴を残して変換する');
  await openSheetPart(page, '貫通穴.pcad', sheetConvertSourceFile(false));
  const form = await openConvertTool(page, '押し出し1');
  await clickWorldPoint(page, [25, 15, 2]);
  await expect(form.getByRole('status').first()).toHaveText('元の立体: 押し出し1');
  const commit = await beginRecompute(page);
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await waitForRecompute(page, commit);
  await tree(page, '板金へ変換1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 - 16 * Math.PI, 4);
  stage('展開図の view-1 を選び、円穴二つの穴表を配置する');
  await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  await unfold.getByRole('button', { name: '展開から図面を作成', exact: true }).click();
  const section = page.locator('.pcad-drawing-property-section[data-property-kind="table"]');
  await expect(section).toBeVisible({ timeout: 60_000 });
  if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click();
  const editor = page.locator('.pcad-drawing-table-editor');
  await editor.getByLabel('表と部品番号', { exact: true }).selectOption('hole');
  await editor.getByLabel('穴の座標を測る図', { exact: true }).selectOption('view-1');
  await editor.getByRole('button', { name: '表を配置', exact: true }).click();
  const table = page.locator('.pcad-drawing-svg [data-owner-id="table-1"]');
  for (const label of ['A1', 'A2', 'φ4']) {
    await expect(table.locator(`[aria-label="${label}"]`)).toHaveCount(2, { timeout: 60_000 });
  }
  await expect(table.locator('[aria-label="A3"]')).toHaveCount(0);
}));

test('M-08 底の残る穴を持つ立体の変換を断り、取消後も元の形とUndoが残る', async ({ page }, testInfo) => withBrowserFailureDiagnostics(page, testInfo, async (stage) => {
  await useBrowserFileEvents(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openSheetPart(page, '止まり穴.pcad', sheetConvertSourceFile(true));
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  await expect(undo).toBeDisabled();
  stage('板厚が一定でない元の立体を選び、変換の拒否理由を確認する');
  const form = await openConvertTool(page, '差1');
  await clickWorldPoint(page, [25, 15, 2]);
  await expect(form.getByRole('status').first()).toHaveText('元の立体: 差1');
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText('板厚が途中で変わっています。厚みをそろえてください。', { timeout: 60_000 });
  stage('取消後も元の立体が残り、変換行とUndoを追加していないことを確認する');
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(tree(page, '板金へ変換1')).toHaveCount(0);
  await expect(undo).toBeDisabled();
  await tree(page, '差1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000 - 4 * Math.PI, 4);
}));
