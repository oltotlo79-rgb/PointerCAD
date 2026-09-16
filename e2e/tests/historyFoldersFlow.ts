import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readRecomputeStats } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';

/** メモを付けた箱を使い、所属と作成順序を混同せず保存・再開する実操作。 */
export async function historyFoldersFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const panel = page.locator('.pcad-panel--left');
  const dialog = page.getByRole('dialog', { name: '履歴フォルダ', exact: true });
  const moved = page.getByRole('dialog', { name: 'フォルダへ移動', exact: true });
  const box = panel.getByRole('button', { name: '箱1', exact: true });
  const before = await readRecomputeStats(page);
  const create = async (name: string, parent?: string) => {
    await panel.getByRole('button', { name: '履歴フォルダを作る', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'フォルダの名前', exact: true }).fill(name);
    if (parent !== undefined) await dialog.getByRole('combobox').selectOption({ label: parent });
    await dialog.getByRole('button', { name: '確定', exact: true }).click();
  };
  await create('加工のまとまり'); await create('仕上げ', '加工のまとまり');
  await box.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'フォルダへ移動', exact: true }).click();
  await moved.getByRole('combobox').selectOption({ label: '加工のまとまり / 仕上げ' });
  await moved.getByRole('button', { name: '確定', exact: true }).click();
  const outer = panel.locator('[data-feature-folder-id="folder-1"]');
  const inner = panel.locator('[data-feature-folder-id="folder-2"]');
  await expect(inner.getByRole('button', { name: '箱1', exact: true })).toBeVisible(); await expect(box).toHaveCount(1);
  await outer.getByRole('button', { name: '加工のまとまり', exact: true }).click(); await expect(box).toHaveCount(0);
  await panel.getByRole('searchbox').fill('箱1');
  await panel.locator('.pcad-name-search li button').filter({ hasText: '箱1' }).click();
  await expect(inner.getByRole('button', { name: '箱1', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '加工のまとまり フォルダを編集', exact: true }).click();
  await expect(dialog.getByRole('option', { name: '加工のまとまり', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('option', { name: '加工のまとまり / 仕上げ', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox').fill('本体の加工'); await dialog.getByRole('button', { name: '確定', exact: true }).click();
  await panel.getByRole('button', { name: '仕上げ フォルダを編集', exact: true }).click();
  await dialog.getByRole('button', { name: 'フォルダを解除', exact: true }).click();
  await expect(inner).toHaveCount(0); await expect(outer.getByRole('button', { name: '箱1', exact: true })).toBeVisible();
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(inner.getByRole('button', { name: '箱1', exact: true })).toBeVisible();
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(before.requestedGeneration);
  const saved = await savePart(page, info, 'history-folders.pcad', app);
  expect(saved.solids.map(solid => solid.name)).toEqual(['箱1']);
  expect(saved.featureNotes?.[0].target).toEqual({ kind: 'solid', id: saved.solids[0].id });
  expect(saved.featureFolders).toEqual([
    { id: 'folder-1', name: '本体の加工', children: [{ kind: 'folder', id: 'folder-2' }] },
    { id: 'folder-2', name: '仕上げ', children: [{ kind: 'solid', id: saved.solids[0].id }] },
  ]);
  await reopenPart(page, info, 'history-folders.pcad', app);
  await expect(inner.getByRole('button', { name: '箱1', exact: true })).toBeVisible();
  const reopened = await readRecomputeStats(page);
  await box.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'フォルダへ移動', exact: true }).click();
  await moved.getByRole('combobox').selectOption(''); await moved.getByRole('button', { name: '確定', exact: true }).click();
  await expect(inner.getByRole('button', { name: '箱1', exact: true })).toHaveCount(0); await expect(box).toHaveCount(1);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(inner.getByRole('button', { name: '箱1', exact: true })).toBeVisible();
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(reopened.requestedGeneration);
  const afterUndo = await savePart(page, info, 'history-folders-after-undo.pcad', app);
  expect(afterUndo.featureFolders).toEqual(saved.featureFolders); expect(afterUndo.featureNotes).toEqual(saved.featureNotes);
  expect(afterUndo.solids).toEqual(saved.solids);
  await panel.getByRole('button', { name: '仕上げ フォルダを編集', exact: true }).click();
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('フォルダにまとめる');
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  await captureManualDetail(page, info, { name: 'history-design-folder', dialog, script: new URL(import.meta.url),
    fixture: { kind: 'history-folder', folders: saved.featureFolders } });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
}
