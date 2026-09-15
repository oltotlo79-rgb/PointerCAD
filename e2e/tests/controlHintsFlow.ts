import { expect, type Page, type TestInfo } from '@playwright/test';
import { readRecomputeStats } from './recompute.js';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';
import { uiMessage } from './uiMessages.js';

async function keyboardFocus(page: Page, control: ReturnType<Page['locator']>): Promise<void> {
  await control.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(control).toBeFocused();
}

export async function controlHintsFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const save = page.getByRole('button', { name: '保存', exact: true });
  const hint = page.locator('.pcad-keyboard-control-hint');
  const before = await readRecomputeStats(page);
  await keyboardFocus(page, save);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText((await save.getAttribute('title')) ?? 'missing-save-title');
  await expect(hint).toContainText('Ctrl');
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(before.requestedGeneration);
  await page.keyboard.press('Escape'); await expect(hint).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const input = page.locator('.pcad-popover input.pcad-field__input').first();
  await input.fill('12/2');
  const originalDescription = await input.getAttribute('aria-describedby');
  if (originalDescription === null) throw new Error('The numeric input must keep its existing result description');
  await keyboardFocus(page, input);
  await expect(hint).toContainText((await input.getAttribute('title')) ?? 'missing-input-title');
  await expect(input).toHaveValue('12/2');
  const description = await input.getAttribute('aria-describedby');
  expect(description).toContain(originalDescription);
  const bounds = await hint.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds !== null) { expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440); }
  await page.screenshot({ path: info.outputPath('keyboard-input-explanation.png') });
  await input.click(); await expect(hint).toHaveCount(0);
  // The real field already has the same title on its label. Exercise that legacy route
  // and restore the actual input title before proceeding with document operations.
  const inputTitle = await input.getAttribute('title');
  if (inputTitle === null) throw new Error('The actual field explanation is missing');
  const label = page.locator(`label[for="${await input.getAttribute('id')}"]`);
  const labelDescription = await label.getAttribute('aria-describedby');
  try {
    await input.evaluate(element => element.removeAttribute('title'));
    await keyboardFocus(page, input);
    await expect(hint).toContainText(inputTitle);
    const tooltipId = await hint.getAttribute('id');
    if (tooltipId === null) throw new Error('The keyboard explanation needs an accessible id');
    expect(await input.getAttribute('aria-describedby')).toContain(tooltipId);
    expect(await label.getAttribute('aria-describedby')).toBe(labelDescription);
  } finally {
    await input.evaluate((element, title) => element.setAttribute('title', title), inputTitle);
  }
  await input.click(); await expect(hint).toHaveCount(0);
  await expect(input).toHaveAttribute('aria-describedby', originalDescription);
  await expect(input).toHaveValue('12/2');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(input).toHaveValue('12/2');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await assertRenderedControlDescriptions(page.getByRole('form', { name: uiMessage('commands', 'settings.shortcuts.title'), exact: true }));
  await assertRenderedControlDescriptions(page.getByRole('form', { name: uiMessage('view', 'settings.toolDefaults.title'), exact: true }));
  await keyboardFocus(page, page.getByLabel(uiMessage('commands', 'settings.shortcuts.command'), { exact: true }));
  await expect(hint).toHaveText(`${uiMessage('commands', 'settings.shortcuts.command')}: ${uiMessage('commands', 'settings.shortcuts.commandGuide')}`);
  await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await keyboardFocus(page, save);
  await expect(hint).toBeVisible();
  const scaled = await hint.boundingBox();
  if (scaled === null) throw new Error('Scaled keyboard explanation is missing');
  expect(scaled.x).toBeGreaterThanOrEqual(0); expect(scaled.y).toBeGreaterThanOrEqual(0);
  expect(scaled.x + scaled.width).toBeLessThanOrEqual(1440);
  expect(scaled.y + scaled.height).toBeLessThanOrEqual(900);
  expect(errors).toEqual([]);
}
