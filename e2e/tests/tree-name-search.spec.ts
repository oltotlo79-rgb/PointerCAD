import { expect, test, type Locator, type Page } from '@playwright/test';
import { boxPartFile, installAssemblyFileGateway, readAssemblyStats, resetAssemblyFileGateway, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

const view = (key: string) => uiMessage('view', key);
const property = (key: string) => uiMessage('propertyPanel', key);

async function openFixture(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  await page.goto('/');
  await installAssemblyFileGateway(page, { documents: [{ name, bytes }] });
  const token = await beginRecompute(page);
  await page.getByRole('group', { name: uiMessage('toolbar', 'toolbar.file.title'), exact: true })
    .getByRole('button', { name: uiMessage('toolbar', 'toolbar.file.open'), exact: true }).click();
  await waitForRecompute(page, token);
}

async function openWithKeyboard(trigger: Locator): Promise<void> {
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

async function compositionEnter(field: Locator, isComposing: boolean, keyCode: number): Promise<void> {
  // A synthetic event checks the browser/React boundary; real candidate selection
  // still needs the OS IME procedure in the worker's final report.
  await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode, isComposing, bubbles: true });
  await expect(field).toBeFocused();
}

test('FIX-10 部品の⋮をキーで巡回し、名前と選択セットの変換確定を分ける', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openFixture(page, boxPartFile(), 'tree-menu.pcad');
    const row = page.locator('.pcad-tree__row--child').filter({ has: page.getByRole('button', { name: '箱1', exact: true }) });
    const trigger = row.getByRole('button', { name: view('featureTree.menuTooltip'), exact: true });
    const menu = page.getByRole('menu');
    const item = (key: string) => menu.getByRole('menuitem', { name: view(key), exact: true });
    await openWithKeyboard(trigger);
    await expect(item('featureTree.suppress')).toBeFocused();
    await expect(item('timeline.moveUp')).toBeDisabled();
    await expect(item('timeline.moveDown')).toBeDisabled();
    await page.keyboard.press('ArrowDown');
    await expect(item('featureTree.rename')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item('featureTree.delete')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('featureTree.suppress')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item('featureTree.delete')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item('featureTree.suppress')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await openWithKeyboard(trigger);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const name = page.getByRole('textbox', { name: view('featureTree.renameLabel'), exact: true });
    await expect(name).toBeFocused();
    await name.fill('取付板');
    await compositionEnter(name, true, 13);
    await compositionEnter(name, false, 229);
    await expect(name).toHaveValue('取付板');
    await name.press('Enter');
    await expect(name).toHaveCount(0);
    const renamed = page.locator('.pcad-panel--left').getByRole('button', { name: '取付板', exact: true });
    await renamed.click({ button: 'right' });
    await page.keyboard.press('Escape');
    const renamedRow = page.locator('.pcad-tree__row--child').filter({
      has: page.getByRole('button', { name: '取付板', exact: true }),
    });
    await expect(renamedRow.getByRole('button', { name: view('featureTree.menuTooltip'), exact: true })).toBeFocused();
    await renamed.click();
    const sets = page.locator('.pcad-panel--right .pcad-section').filter({
      has: page.getByRole('heading', { name: property('propertyPanel.sectionSelectionSets'), exact: true }),
    });
    const newName = sets.getByRole('textbox', { name: property('propertyPanel.selectionSetName'), exact: true });
    await newName.fill('外側');
    await compositionEnter(newName, true, 13);
    await expect(sets.locator('.pcad-constraint-row')).toHaveCount(0);
    await newName.press('Enter');
    await expect(sets.locator('.pcad-constraint-row')).toHaveCount(1);
    await sets.locator('.pcad-constraint-row__pick').dblclick();
    const renameSet = sets.locator('.pcad-constraint-row input');
    await renameSet.fill('組立用');
    await compositionEnter(renameSet, false, 229);
    await renameSet.press('Enter');
    await expect(renameSet).toHaveCount(0);
    await expect(sets.locator('.pcad-constraint-row__label')).toHaveText('組立用');
    expect(errors).toEqual([]);
  } finally { await resetAssemblyFileGateway(page); }
});

test('FIX-10 組立の⋮を上下/Home/End/Enterで操作し、Escで同じ行へ戻る', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openFixture(page, await twoBoxAssemblyFile(), 'tree-menu.pcada');
    const row = page.locator('[data-name-search-key="component:component-1"]');
    const trigger = row.getByRole('button', { name: view('featureTree.menuTooltip'), exact: true });
    const menu = page.getByRole('menu');
    const items = menu.getByRole('menuitem');
    const before = (await readAssemblyStats(page)).components.find(component => component.id === 'component-1');
    expect(before).toBeDefined();
    await openWithKeyboard(trigger);
    await expect(items).toHaveCount(5);
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(4)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.nth(4)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(2)).toBeFocused();
    await expect(items.nth(2)).toHaveText(uiMessage('assembly', before?.fixed === true ? 'assembly.tree.unfix' : 'assembly.tool.fixComponent'));
    const token = await beginRecompute(page);
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await waitForRecompute(page, token);
    expect((await readAssemblyStats(page)).components.find(component => component.id === 'component-1')?.fixed).toBe(!before?.fixed);
    await openWithKeyboard(trigger);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await row.locator('.pcad-tree__select').click({ button: 'right' });
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    expect(errors).toEqual([]);
  } finally { await resetAssemblyFileGateway(page); }
});
