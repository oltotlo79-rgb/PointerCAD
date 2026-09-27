import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  mathGeometryComparisonFlow, mathGeometryReferenceFlow, mathGeometryToleranceFlow, mathGeometryUsageFlow,
} from './mathGeometryReferenceFlow.js';

/*
 * GR-24: the tool "図形の測定値" in Chromium (functional) and Firefox. The name ends in math-input.spec.ts, so the
 * Firefox project's testMatch includes it without a configuration change. Real Electron uses the same flows (GR-24e).
 * No flow prepares the exact runtime. 2026-09-24 (2 workers, Chromium and Firefox together): the long flow took
 * 48.1 s / 55.5 s and the others at most 42.3 s; each individual wait keeps its own shared limit (recompute 150 s).
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function run(page: Page, info: TestInfo, flow: typeof mathGeometryReferenceFlow): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  // Saves use the download path and opening uses the file chooser in every browser.
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await flow(page, info);
  expect(errors).toEqual([]);
}

test('ADD-23 図形の測定値を道具・対象の両方の順で追加し、改名・係数作成・係数の式・形の変更・保存再開・循環・F1を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  await run(page, info, mathGeometryReferenceFlow);
});

test('ADD-23 使用中の図形の測定値は、使っている係数の名前を示して削除を断る', async ({ page }, info) => {
  test.setTimeout(180_000);
  await run(page, info, mathGeometryUsageFlow);
});

test('ADD-23 比べる幅で平行の判定を変え、Undo・Redo・保存再開で幅を保つ', async ({ page }, info) => {
  test.setTimeout(180_000);
  await run(page, info, mathGeometryToleranceFlow);
});

test('ADD-23 線分どうしの合同・相似を追加し、長さの比べる幅で合同の判定を変える', async ({ page }, info) => {
  test.setTimeout(180_000);
  await run(page, info, mathGeometryComparisonFlow);
});
