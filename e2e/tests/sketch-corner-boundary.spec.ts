/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  chooseEditTool, clickWorldPoint, commitPopover, drawRectangle, extrudeFace,
  makeFace, popoverTitle, propertyValue, statusText, treeRow,
} from './sketchFinishCaptureSupport.js';

test.use({ viewport: { width: 1440, height: 900 } });

async function expectVolume(page: Page, expected: number): Promise<void> {
  await treeRow(page, '押し出し1').click();
  await expect.poll(async () => {
    const value = propertyValue(page, '体積');
    return await value.count() === 0 ? Number.POSITIVE_INFINITY
      : Math.abs(Number.parseFloat(await value.innerText()) - expected);
  }, { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
}

async function savePart(page: Page, info: TestInfo, name: string) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name: '保存', exact: true }).click();
  const path = info.outputPath(`${name}.pcad`);
  await (await downloading).saveAs(path);
  await expect(statusText(page)).toHaveText('保存しました');
  const saved = readPcadFile(await readFile(path));
  if (!saved.ok) throw new Error(saved.error.message);
  return { path, document: saved.document };
}

for (const tool of ['フィレット', '面取り'] as const) {
  test(`F07 面と押し出しを作った後の${tool}で境界・Undo・保存を保つ`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
      }
    });
    await page.goto('/');
    await waitForStartupHealth(page, info);
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['矩形1']);
    await extrudeFace(page, '面1', '10');
    await expectVolume(page, 12000);
    const before = await savePart(page, info, 'before');

    await chooseEditTool(page, tool);
    await clickWorldPoint(page, [40, 0, 0]);
    await expect(popoverTitle(page)).toHaveText(tool === 'フィレット' ? '角を丸める' : '面を取る');
    const applied = await beginRecompute(page);
    await commitPopover(page);
    await waitForRecompute(page, applied);
    await expect(statusText(page)).toContainText('角の加工に合わせて面の境界も更新しました');
    // 直角から除く面積: R5 は 25−25π/4、C3 は 3×3/2。
    const volume = 12000 - (tool === 'フィレット' ? 25 * (1 - Math.PI / 4) : 4.5) * 10;
    await expectVolume(page, volume);

    const undone = await beginRecompute(page);
    await page.keyboard.press('Control+z');
    await waitForRecompute(page, undone);
    await expect(treeRow(page, '矩形1')).toBeVisible();
    await expectVolume(page, 12000);
    const redone = await beginRecompute(page);
    await page.keyboard.press('Control+y');
    await waitForRecompute(page, redone);
    await expectVolume(page, volume);

    const after = await savePart(page, info, 'after');
    expect(after.document.solids).toEqual(before.document.solids);
    const beforeFace = before.document.sketches[0].features.find((feature) => feature.kind === 'face');
    const afterFace = after.document.sketches[0].features.find((feature) => feature.id === beforeFace?.id);
    expect(afterFace).toMatchObject({ id: beforeFace?.id, kind: 'face', name: beforeFace?.name });
    if (afterFace?.kind !== 'face') throw new Error('Missing saved face');
    expect(afterFace.boundary).toHaveLength(5);

    const files = page.getByRole('group', { name: 'ファイル' });
    await files.getByRole('button', { name: '新規', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await files.getByRole('button', { name: '開く', exact: true }).click();
    const opened = await beginRecompute(page);
    await (await chooser).setFiles(after.path);
    await waitForRecompute(page, opened);
    await expect(treeRow(page, '面1')).toBeVisible();
    await expectVolume(page, volume);
    expect(errors).toEqual([]);
  });
}
