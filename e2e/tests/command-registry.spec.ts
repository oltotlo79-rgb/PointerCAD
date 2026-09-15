/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
});

test('共通command IDのボタンと実際のキーが同じ保存・履歴操作を呼ぶ', async ({ page }, info) => {
  await page.goto('/');
  await waitForStartupHealth(page, info);

  const save = page.getByRole('button', { name: '保存', exact: true });
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  const redo = page.getByRole('button', { name: 'やり直す', exact: true });
  await expect(save).toHaveAttribute('data-command-id', 'file.save');
  await expect(undo).toHaveAttribute('data-command-id', 'history.undo');
  await expect(redo).toHaveAttribute('data-command-id', 'history.redo');

  const command = page.locator('#pcad-command-line-input');
  await command.fill('PO'); await command.press('Enter');
  await command.fill('12,34'); await command.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true })).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true })).toHaveCount(0);
  await redo.click();
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true })).toBeVisible();

  await command.fill('編集中');
  const saving = page.waitForEvent('download');
  await command.press('Control+s');
  expect(await (await saving).failure()).toBeNull();
  await expect(command).toHaveValue('編集中');
});

test('入力・IME・ダイアログのキーを横取りせずF1と生成一覧は一致する', async ({ page }, info) => {
  await page.goto('/');
  await waitForStartupHealth(page, info);
  const command = page.locator('#pcad-command-line-input');
  await command.fill('12');
  await command.press('3');
  await expect(command).toHaveValue('123');

  await command.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }));
  });
  await expect(command).toHaveValue('123');

  await command.evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
  });
  await command.press('F1');
  const help = page.locator('.pcad-help');
  await expect(help).toBeVisible();
  await help.getByRole('searchbox', { name: uiMessage('help', 'help.search'), exact: true }).fill('ショートカット一覧');
  await help.locator('.pcad-help__topic').filter({ hasText: 'ショートカット一覧' }).click();
  const article = help.locator('.pcad-help__article');
  await expect(article).toContainText('Ctrl/Cmd+S');
  await expect(article).toContainText('入力欄でも有効');
  await expect(article.locator('text=pointercad:current-shortcuts')).toHaveCount(0);
});

test('P12-5 キー移動でも入力と同じ説明を読み、元の値・操作・拡大表示を保つ', async ({ page }, info) => {
  const { controlHintsFlow } = await import('./controlHintsFlow.js');
  await page.goto('/'); await waitForStartupHealth(page, info);
  await controlHintsFlow(page, info);
});

test('P12-2・3 全ての説明章と画像を開き、検索・F1後も入力と保存文書を保つ', async ({ page }, info) => {
  const { helpReaderFlow } = await import('./helpReaderFlow.js');
  await page.goto('/'); await waitForStartupHealth(page, info);
  await helpReaderFlow(page, info);
});
