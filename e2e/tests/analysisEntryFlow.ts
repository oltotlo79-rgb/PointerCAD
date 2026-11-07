import { expect, type Page } from '@playwright/test';
import { openToolMenu, chooseToolMenuItem, toolMenuPanel } from './assemblyTestSupport.js';
import { waitForSettledRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

export const analysisEntries = [
  { id: 'beam', catalog: 'beam', panel: 'beam-panel', kind: 'assembly' },
  { id: 'plasticBar', catalog: 'plasticBar', panel: 'plastic-bar-panel', kind: 'part' },
  { id: 'fatigue', catalog: 'fatigue', panel: 'fatigue-panel', kind: 'part' },
  { id: 'fatigueStrain', catalog: 'fatigueStrain', panel: 'fatigue-strain-panel', kind: 'part' },
  { id: 'fatigueLocalCycle', catalog: 'fatigueLocalCycle', panel: 'fatigue-local-cycle-panel', kind: 'part' },
  { id: 'solidAnalysis', catalog: 'solidAnalysis', panel: 'solid-analysis-panel', kind: 'part' },
  { id: 'solidPlastic', catalog: 'solidPlastic', panel: 'solid-plastic-panel', kind: 'part' },
] as const;
const menuName = uiMessage('toolbar', 'toolbar.analysis.groupLabel');

async function expectOneToolbarRow(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.pcad-toolbar').evaluate(toolbar => {
    const rows = Array.from(toolbar.children, child => child.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0);
    if (rows.length === 0) return false;
    const span = Math.max(...rows.map(rect => rect.bottom)) - Math.min(...rows.map(rect => rect.top));
    // Fractional font/layout rounding may differ by a CSS pixel; another flex row cannot fit this margin.
    return span <= Math.max(...rows.map(rect => rect.height)) + 2 && toolbar.scrollWidth <= toolbar.clientWidth;
  })).toBe(true);
}

export async function analysisEntryFlow(page: Page, entry: typeof analysisEntries[number], desktop = false): Promise<void> {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1440, height: 900 });
    if (!desktop) await page.goto('/');
    await waitForSettledRecompute(page);
    if (entry.kind === 'assembly') {
      await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.fileMenu.groupLabel'), uiMessage('assembly', 'assembly.file.new'));
    }
    const trigger = page.locator('.pcad-toolbar').getByRole('button', { name: new RegExp(`^${menuName}`, 'u') });
    await expect(trigger).toHaveCount(1); await expect(trigger).toBeVisible();
    await expectOneToolbarRow(page);
    await expect(page.getByRole('form', { name: uiMessage('strength', 'strength.title'), exact: true })).toHaveCount(0);
    await expect(page.getByTestId(entry.panel)).toHaveCount(0);
    await openToolMenu(page, menuName);
    const menu = toolMenuPanel(page, menuName);
    await expect(menu.getByRole('button')).toHaveCount(entry.kind === 'part' ? 8 : 5);
    for (const id of ['solidFinite', 'shellAnalysis'] as const) {
      const extra = menu.getByRole('button', { name: uiMessage(id, `${id}.open`), exact: true });
      await expect(extra).toHaveCount(entry.kind === 'part' ? 1 : 0);
      if (entry.kind === 'part') await expect(extra).toHaveAttribute('data-command-id', `toolbar.analysis.${id}`);
    }
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();

    await openToolMenu(page, menuName);
    const label = uiMessage(entry.catalog, `${entry.id}.open`);
    const item = menu.getByRole('button', { name: label, exact: true });
    await expect(item).toHaveAttribute('data-command-id', `toolbar.analysis.${entry.id}`);
    await expect(item).toHaveAttribute('data-help-topic', 'strength');
    await item.focus(); await page.keyboard.press('F1');
    const help = page.locator('.pcad-help');
    await expect(help.locator('article').getByRole('heading', { name: '梁・軸・ボルトの簡易強度計算', exact: true })).toBeVisible();
    await help.getByRole('button', { name: uiMessage('help', 'help.close'), exact: true }).click();
    await expect(help).toHaveCount(0);

    if (entry.id === 'plasticBar') {
      await expect(menu).toHaveCount(0);
      await trigger.focus(); await page.keyboard.press('Enter');
      await expect(menu).toBeVisible(); await page.keyboard.press('Home');
      await expect(item).toBeFocused(); await page.keyboard.press('Enter');
    } else {
      await chooseToolMenuItem(page, menuName, label);
    }
    await expect(page.getByTestId(entry.panel)).toBeVisible();
    await expect(menu).toHaveCount(0);

    if (entry.id === 'plasticBar') {
      const source = page.getByTestId('plastic-bar-source');
      await source.fill('入口の保持確認');
      await chooseToolMenuItem(page, menuName, label);
      await expect(source).toHaveValue('入口の保持確認');
      await openToolMenu(page, menuName);
      const other = menu.getByRole('button', { name: uiMessage('fatigue', 'fatigue.open'), exact: true });
      await expect(other).toHaveAttribute('aria-disabled', 'true');
      await expect(other).toHaveAttribute('title', new RegExp(uiMessage('toolbar', 'toolbar.analysis.closeCurrent'), 'u'));
      await other.focus(); await page.keyboard.press('Enter');
      await expect(page.getByTestId('fatigue-panel')).toHaveCount(0);
      await expect(source).toHaveValue('入口の保持確認');
    }
    expect(errors).toEqual([]);
}
