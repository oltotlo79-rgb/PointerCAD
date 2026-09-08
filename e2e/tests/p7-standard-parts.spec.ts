import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  chooseToolMenuItem,
  installAssemblyFileGateway,
  readAssemblyStats,
  resetAssemblyFileGateway,
  twoBoxAssemblyFile,
} from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

function fileAction(page: Page, name: string): Locator {
  return page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name, exact: true });
}

async function chooseFileMenu(page: Page, name: string): Promise<void> {
  await chooseToolMenuItem(page, 'ファイルのほかの操作', name);
}

function treeSectionRows(page: Page, sectionName: string): Locator {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: sectionName }),
  });
  return section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
}

async function selectComponent(page: Page, index: number): Promise<void> {
  const row = treeSectionRows(page, '部品').nth(index).locator('.pcad-tree__select');
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

async function startEmptyAssembly(page: Page): Promise<void> {
  const token = await beginRecompute(page);
  await chooseFileMenu(page, '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

async function openAssemblyFixture(page: Page, bytes: Uint8Array): Promise<void> {
  await installAssemblyFileGateway(page, { documents: [{ name: 'joint.pcada', bytes }] });
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  await waitForRecompute(page, token);
  await expect(treeSectionRows(page, '部品')).toHaveCount(2);
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('P7 規格部品とジョイント', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

  test('(d) 規格のM8六角ボルトを置くと部品表に17.93g±0.1gの質量が出る', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await page.goto('/');
    await startEmptyAssembly(page);
    await chooseToolMenuItem(page, '組む', '規格部品');
    const picker = page.getByRole('dialog', { name: '規格部品を置く' });
    await expect(picker).toBeVisible();
    // 17.93gは§2.8で検算した本体規格(k=5.3mm)の値。既定の附属書JA(k=5.5mm)から明示的に切り替える。
    await picker.locator('select').nth(1).selectOption('main');
    await expect(picker.locator('select').nth(1)).toHaveValue('main');
    const size = picker.locator('select').nth(3);
    await size.selectOption({ label: 'M8' });
    await expect(size.locator('option:checked')).toHaveText('M8');
    const token = await beginRecompute(page);
    await picker.getByRole('button', { name: '置く', exact: true }).click();
    await waitForRecompute(page, token);
    await picker.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(treeSectionRows(page, '部品')).toHaveCount(1);

    await page.getByRole('group', { name: '組む' })
      .getByRole('button', { name: '部品表', exact: true }).click();
    const massText = await page.locator('.pcad-bom__table tbody tr td').nth(4).innerText();
    const mass = Number.parseFloat(massText);
    console.log(`[実測] M8×30六角ボルトの質量: ${mass.toFixed(2)} g (期待17.93±0.1g)`);
    expect(mass).toBeGreaterThanOrEqual(17.83);
    expect(mass).toBeLessThanOrEqual(18.03);
    expect(errors).toEqual([]);
  });

  test('(e) 回転ジョイントを動かすと可動部品だけが回り、30°〜120°の端で止まる', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const fixture = await twoBoxAssemblyFile(40);
    await page.goto('/');
    await openAssemblyFixture(page, fixture);
    await chooseToolMenuItem(page, '合わせる', '回転');
    const dialog = page.getByRole('dialog', { name: 'ジョイントを作る' });
    await expect(dialog).toBeVisible();
    for (const index of [0, 1]) {
      await selectComponent(page, index);
      await dialog.getByRole('button', { name: 'Z軸', exact: true }).click();
    }
    const rangeInputs = dialog.locator('input.pcad-field__input');
    await rangeInputs.nth(0).fill('30');
    await rangeInputs.nth(1).fill('120');
    const token = await beginRecompute(page);
    await dialog.getByRole('button', { name: 'ジョイントを作る', exact: true }).click();
    await waitForRecompute(page, token);
    await expect(treeSectionRows(page, 'ジョイント')).toHaveCount(1);
    const before = await readAssemblyStats(page);

    const motion = page.getByRole('group', { name: '組み立ての動き' });
    const numberInput = motion.locator('.pcad-assembly-motion__joint input[type="number"]');
    await expect(numberInput).toBeVisible();
    await numberInput.fill('60');
    await expect.poll(async () => (await readAssemblyStats(page)).jointValues[0]?.value).toBeCloseTo(60, 5);
    const moved = await readAssemblyStats(page);
    expect(moved.components[0]?.displayed).toEqual(before.components[0]?.displayed);
    expect(moved.components[1]?.displayed?.rotation).not.toEqual(before.components[1]?.displayed?.rotation);

    await numberInput.fill('145');
    await expect(numberInput).toHaveValue('120');
    await expect.poll(async () => (await readAssemblyStats(page)).jointValues[0]?.value).toBeCloseTo(120, 5);
    await expect(motion.locator('.pcad-field__message[role="status"]'))
      .toContainText('可動範囲の端です(30°〜120°)。');
    expect(errors).toEqual([]);
  });
});
