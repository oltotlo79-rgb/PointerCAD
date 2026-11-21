import { expect, test, type Page } from '@playwright/test';
import { blendSurfaceFlow, surfacesFlow, sweepShapeFlow, thickenSurfaceFlow } from './surfacesFlow.js';

async function withoutFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
}

test('P11b 曲面の自由曲線ロフト・平滑化・案内線・保存再編集・F1', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await withoutFilePickers(page);
  await page.goto('/'); await surfacesFlow(page, info); expect(errors).toEqual([]);
});

test('M-07 スイープのねじれ・終わりの大きさ・肉厚で作り、右の欄で直し、版 24 で保存する', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await withoutFilePickers(page);
  await page.goto('/'); await sweepShapeFlow(page, info); expect(errors).toEqual([]);
});

test('J-05a 面だけのボディに厚み付けして体積 600 の立体にし、保存・開き直しても同じ', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await withoutFilePickers(page);
  await page.goto('/'); await thickenSurfaceFlow(page, info); expect(errors).toEqual([]);
});

test('J-05b 2 枚の面の境界辺を 3D で選んで滑らかにつなぎ、性質欄で反転を直して保存・開き直す', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await withoutFilePickers(page);
  await page.goto('/'); await blendSurfaceFlow(page, info); expect(errors).toEqual([]);
});
