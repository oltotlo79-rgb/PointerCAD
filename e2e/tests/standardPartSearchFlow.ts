import { expect, test as baseTest, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { chooseToolMenuItem, readAssemblyStats } from './assemblyTestSupport.js';
import { disableFilePickers } from './filePickers.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { watch } from './runtimeErrors.js';
import { uiMessage } from './uiMessages.js';

/*
 * 規格部品の選ぶ窓の検索(K-07a)の画面検査。空の組立で窓を開き、検索の欄だけで選び直して置く(完成した組立を API で作って注入しない)。
 * 1) 分類を六角ナットにしてから「六角ボルト M10」で探し、Enter で 1 件目(言葉と同じ呼びの行。今の分類の六角ボルトの附属書JA の M10)へ
 *    選び直す: 分類・寸法系・呼び寸法の欄が替わり、検索の欄は空になる。
 * 2) 当てはまらない言葉では「当てはまる部品がありません」と出し、Enter で置かない。Esc は言葉だけを消し、窓は閉じない。
 * 3) 「カムフォロア」で探す(全部の族の表を読む)。2 件目を押すと、分類が機械要素・種類がカムフォロア・呼びがその行になり、置くと部品が 1 つ増える。
 * 今の欄は位置で探す画面検査があるので、検索の欄は欄の class と label の形を使わず、役割と名前で探す(この spec もそう探す)。
 * 2 件目(K-07b): 置いた物が「最近使った物」に出て、窓を閉じて開き直しても残り、押すとその物へ選び直す(アプリを閉じるまでだけ持つ)。
 */

const CAM_FOLLOWER_FAMILY = 'cam-follower-stud-metric';

function picker(page: Page): Locator {
  return page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });
}

function combo(dialog: Locator, catalog: string, key: string): Locator {
  return dialog.getByRole('combobox', { name: uiMessage(catalog, key), exact: true });
}

async function startEmptyAssembly(page: Page, app: ElectronApplication | undefined): Promise<void> {
  if (app === undefined) {
    await disableFilePickers(page);
    await page.goto('/');
  }
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

export function registerStandardPartSearchTests(test: typeof baseTest,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('規格部品の選ぶ窓の検索(K-07a)', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('検索で六角ボルトと族の行へ選び直し、当てはまらない言葉の Enter では置かず、Esc は言葉だけを消す', async ({ page }) => {
      const seen = watch(page);
      await startEmptyAssembly(page, appForPage(page));
      await chooseToolMenuItem(page, '組む', '規格部品');
      const dialog = picker(page);
      await expect(dialog).toBeVisible();
      const search = dialog.getByRole('searchbox', { name: uiMessage('assembly', 'assembly.standardPart.search.label'), exact: true });
      const results = dialog.getByRole('listbox', { name: uiMessage('assembly', 'assembly.standardPart.search.results'), exact: true });
      const category = combo(dialog, 'assembly', 'assembly.standardPart.category');

      // 1) 今の分類の行へ選び直す。
      await category.selectOption('hexNut');
      await search.fill('六角ボルト M10');
      await expect(results.getByRole('option').first()).toContainText('六角ボルト M10');
      await search.press('Enter');
      await expect(category).toHaveValue('hexBolt');
      await expect(combo(dialog, 'assembly', 'assembly.standardPart.dimensionSeries')).toHaveValue('annexJA');
      await expect(combo(dialog, 'assembly', 'assembly.standardPart.size').locator('option:checked')).toHaveText('M10');
      await expect(search).toHaveValue('');
      await expect(results).toHaveCount(0);

      // 2) 当てはまらない言葉の Enter は置かない。Esc は言葉だけを消す。
      await search.fill('zzz 当てはまらない');
      await expect(dialog.getByText(uiMessage('assembly', 'assembly.standardPart.search.none'), { exact: true })).toBeVisible();
      await search.press('Enter');
      await search.press('Escape');
      await expect(search).toHaveValue('');
      await expect(dialog).toBeVisible();
      expect((await readAssemblyStats(page)).components).toHaveLength(0);

      // 3) 族の行(全部の族の表を読んでから出る)へ選び直して置く。
      await search.fill('カムフォロア');
      const second = results.getByRole('option').nth(1);
      await expect(second).toBeVisible();
      const label = await second.locator('.pcad-picker-search__label').innerText();
      await second.click();
      await expect(category).toHaveValue('mechanical');
      await expect(combo(dialog, 'catalog', 'catalog.mechanical.kind')).toHaveValue(CAM_FOLLOWER_FAMILY);
      const row = await combo(dialog, 'assembly', 'assembly.standardPart.size').locator('option:checked').innerText();
      expect(label).toContain(row);
      const token = await beginRecompute(page);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
      await waitForRecompute(page, token);
      expect((await readAssemblyStats(page)).components).toHaveLength(1);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });

    test('置いた物が最近使った物に出て、窓を閉じて開き直した後に押すと、分類・種類・呼びがその物に戻る(K-07b)', async ({ page }) => {
      const seen = watch(page);
      await startEmptyAssembly(page, appForPage(page));
      await chooseToolMenuItem(page, '組む', '規格部品');
      const dialog = picker(page);
      const search = dialog.getByRole('searchbox', { name: uiMessage('assembly', 'assembly.standardPart.search.label'), exact: true });
      const recent = dialog.getByRole('group', { name: uiMessage('assembly', 'assembly.standardPart.recent.label'), exact: true });
      const category = combo(dialog, 'assembly', 'assembly.standardPart.category');
      await expect(recent).toHaveCount(0);

      // 族の行を検索で選んで置く。
      await search.fill('カムフォロア');
      const second = dialog.getByRole('listbox', { name: uiMessage('assembly', 'assembly.standardPart.search.results'), exact: true })
        .getByRole('option').nth(1);
      const label = await second.locator('.pcad-picker-search__label').innerText();
      await second.click();
      const row = await combo(dialog, 'assembly', 'assembly.standardPart.size').locator('option:checked').innerText();
      const token = await beginRecompute(page);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(recent.getByRole('button')).toHaveCount(1);
      await expect(recent.getByRole('button').first()).toContainText(label);

      // 閉じて開き直し、分類を替えてから最近使った物を押す。
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await chooseToolMenuItem(page, '組む', '規格部品');
      await category.selectOption('hexNut');
      await recent.getByRole('button').first().click();
      await expect(category).toHaveValue('mechanical');
      await expect(combo(dialog, 'catalog', 'catalog.mechanical.kind')).toHaveValue(CAM_FOLLOWER_FAMILY);
      await expect(combo(dialog, 'assembly', 'assembly.standardPart.size').locator('option:checked')).toHaveText(row);
      expect((await readAssemblyStats(page)).components).toHaveLength(1);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });

    test('寸法の図と表: 開くと線図と表が出て、基本の形の部品は表だけ、族へ選び直すと族の線図、窓を開き直しても開いたまま(K-07c)', async ({ page }) => {
      const seen = watch(page);
      await startEmptyAssembly(page, appForPage(page));
      await chooseToolMenuItem(page, '組む', '規格部品');
      const dialog = picker(page);
      const figure = dialog.locator('details.pcad-dimension-figure');
      const summary = figure.locator('summary');
      const image = figure.getByRole('img');
      const table = figure.getByRole('table', { name: uiMessage('catalog', 'catalog.dimensionFigure.tableCaption'), exact: true });
      const rowHeader = (key: string): Locator => table.getByRole('rowheader', { name: uiMessage('catalog', key), exact: true });
      const category = combo(dialog, 'assembly', 'assembly.standardPart.category');

      // 既定の六角ボルト M8: 閉じて始まり、開くと頭の六角の線図(幅と高さの入った名前)と表(二面幅の行)。
      await expect(summary).toHaveText(uiMessage('catalog', 'catalog.dimensionFigure.title'));
      await expect(image).toBeHidden();
      await summary.click();
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute('aria-label', /mm/u);
      await expect(rowHeader('catalog.dimension.acrossFlats')).toBeVisible();

      // 深溝玉軸受(基本の形で作る部品): 線図は無く、その知らせと表(内径の行)。
      await category.selectOption('deepGrooveBallBearing');
      await expect(image).toHaveCount(0);
      await expect(figure.getByText(uiMessage('catalog', 'catalog.dimensionFigure.noFigure'), { exact: true })).toBeVisible();
      await expect(rowHeader('catalog.dimension.innerDiameter')).toBeVisible();

      // 族(アルミの角パイプ)へ検索で選び直す: 外周と内周の 2 本の線図。
      await dialog.getByRole('searchbox', { name: uiMessage('assembly', 'assembly.standardPart.search.label'), exact: true })
        .fill(uiMessage('catalog', 'catalog.frame.kind.squarePipe'));
      await dialog.getByRole('listbox', { name: uiMessage('assembly', 'assembly.standardPart.search.results'), exact: true })
        .getByRole('option').first().click();
      await expect(category).toHaveValue('aluminumFrame');
      await expect(image).toBeVisible();
      await expect(image.locator('path.pcad-dimension-figure__outline')).toHaveCount(2);

      // 窓を閉じて開き直しても開いたまま(アプリを閉じるまで覚える)。
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await chooseToolMenuItem(page, '組む', '規格部品');
      await expect(image).toBeVisible();
      expect((await readAssemblyStats(page)).components).toHaveLength(0);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });
  });
}
