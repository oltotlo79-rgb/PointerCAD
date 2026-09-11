import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, saveTarget, openTarget, diskFile } from './electronAppFlow.js';
import { intersectionEditingFlow, editReopenedIntersection, verifyIntersectionFile } from './intersectionsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

test('ADD-1 交点の接続と区間編集を実Electronの保存再開でも維持する', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await intersectionEditingFlow(page, info);
    const path = join(directory, '交点の編集.pcad'); await saveTarget(app, path);
    await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+s');
    verifyIntersectionFile(await diskFile(path));
    await page.reload(); await openTarget(app, path);
    await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
    const token = await beginRecompute(page); await page.getByRole('button', { name: '開く', exact: true }).click();
    await waitForRecompute(page, token); await editReopenedIntersection(page); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
