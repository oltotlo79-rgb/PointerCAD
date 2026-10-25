import { expect, test, type Page } from '@playwright/test';
import { expectMemoryEmptyDocument, memorySolidDimensionField } from './memoryHighwaterFlow.js';

async function emptyFixture(page: Page, kind: 'solid' | 'assembly'): Promise<void> {
  const labels = kind === 'assembly' ? ['部品', '合致', 'ジョイント', '分解ステップ'] : ['ソリッド', 'スケッチ'];
  await page.setContent('<section class="pcad-panel--left">' + labels.map(label =>
    `<button>${label} <span>0</span></button>`).join('') + '</section>');
  await page.evaluate(() => {
    // Only this isolated DOM fixture supplies observers. Production flow never writes them.
    window.pcadViewportFramedBodies = () => [];
    window.pcadAssemblyStats = () => ({ components: [], mateIds: [], jointIds: [], stepIds: [],
      diagnosis: null, jointValues: [], interferenceSelectedKey: null });
  });
}

test('primitive textbox uses the actual accessible label outside property-list and excludes other fields', async ({ page }) => {
  await page.setContent('<section class="pcad-panel--left"><input aria-label="X の長さ" value="99"></section>'
    + '<section class="pcad-panel--right"><div class="pcad-coordinate__fields">'
    + '<input aria-label="X の長さ" value="20"><input aria-label="Y の長さ" value="20">'
    + '<input aria-label="X" value="0"></div></section>');
  expect(await page.locator('.pcad-property-list input').count()).toBe(0);
  const field = memorySolidDimensionField(page);
  await expect(field).toHaveCount(1); await field.fill('21'); await expect(field).toHaveValue('21');
  await expect(page.locator('.pcad-panel--left input')).toHaveValue('99');
  await expect(page.getByRole('textbox', { name: 'Y の長さ', exact: true })).toHaveValue('20');
  await expect(page.getByRole('textbox', { name: 'X', exact: true })).toHaveValue('0');
});

test('a centre-X field or another dimension cannot substitute for the missing box-X field', async ({ page }) => {
  await page.setContent('<section class="pcad-panel--right"><input aria-label="X" value="20">'
    + '<input aria-label="Y の長さ" value="20"></section>');
  await expect(memorySolidDimensionField(page)).toHaveCount(0);
});

test('both actual document kinds require their complete empty sections and released viewport', async ({ page }) => {
  for (const kind of ['solid', 'assembly'] as const) {
    await emptyFixture(page, kind);
    await expectMemoryEmptyDocument(page, kind);
  }
});

test('empty-looking assembly UI cannot hide a retained component or relation in the existing observer', async ({ page }) => {
  for (const field of ['components', 'mateIds', 'jointIds', 'stepIds'] as const) {
    await emptyFixture(page, 'assembly');
    await page.evaluate(field => {
      const read = window.pcadAssemblyStats;
      if (read === undefined) throw new Error('Fixture observer absent');
      const state = read();
      Reflect.set(state, field, ['retained']);
      window.pcadAssemblyStats = () => state;
    }, field);
    await expect(expectMemoryEmptyDocument(page, 'assembly')).rejects.toThrow();
  }
});

test('empty document sections do not qualify retained viewport geometry as released', async ({ page }) => {
  test.setTimeout(45_000);
  await emptyFixture(page, 'solid');
  await page.evaluate(() => { window.pcadViewportFramedBodies = () => ['retained-body']; });
  await expect(expectMemoryEmptyDocument(page, 'solid')).rejects.toThrow();
});
