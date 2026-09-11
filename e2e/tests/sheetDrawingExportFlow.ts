import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';

export async function sheetDrawingVectorFlow(page: Page, testInfo: TestInfo): Promise<void> {
  const instruction = page.locator('.pcad-drawing-svg [data-owner-id="view-1"] [aria-label="上 90° R3"]');
  await expect(instruction).toHaveCount(1);
  const dashed = page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path[stroke-dasharray]');
  await expect.poll(() => dashed.count()).toBeGreaterThan(0);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  await page.getByRole('button', { name: '図面を書き出す', exact: true }).click();
  const form = page.getByRole('form', { name: '図面を書き出す', exact: true });
  await form.getByLabel('ファイルの種類', { exact: true }).selectOption('svg');
  const downloading = page.waitForEvent('download'); await form.getByRole('button', { name: '書き出す', exact: true }).click();
  const path = testInfo.outputPath('sheet-bend-instructions.svg'); await (await downloading).saveAs(path);
  const text = await readFile(path, 'utf8');
  expect(text).toContain('上 90° R3'); expect(text).toContain('stroke-dasharray'); expect(text).not.toContain('<text');
  expect(text).toContain('width="420mm"');
  await expect(form).toHaveCount(0);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  await page.getByRole('button', { name: '図面を書き出す', exact: true }).click();
  await form.getByLabel('ファイルの種類', { exact: true }).selectOption('pdf');
  const pdfDownloading = page.waitForEvent('download'); await form.getByRole('button', { name: '書き出す', exact: true }).click();
  const pdfPath = testInfo.outputPath('sheet-bend-instructions.pdf'); await (await pdfDownloading).saveAs(pdfPath);
  await expect(form).toHaveCount(0);
  const pdf = (await readFile(pdfPath)).toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('/MediaBox[0 0 1190.5512 841.8898]');
  expect(pdf).not.toMatch(/\/(?:Font|Image)\b/u);
  expect(pdf).toMatch(/\[[\d. ]+\] 0 d/u);
  expect(pdf).toContain(' c\n');

}
