/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem, readAssemblyStats, resetAssemblyFileGateway, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome } from './boltedJointTestSupport.js';
import { disableFilePickers } from './filePickers.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { chooseSteelFlatBar50x6 } from './steelPickerFlow.js';
import { waitForStartupReady } from './startupHealth.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-06: the standard-part picker's アルミフレーム category, only through the real UI (no fixture file, no store injection).
 * The generic T-slot frame is placed with length 500 (after an impossible slot opening is refused with its reason), the
 * frame series row 溝幅 6 20×20 with length 750; the picker's cut list and the BOM are read, then the assembly is saved and
 * reopened and the same rows are read again.
 * Independent expectation for the series mass: the row's unit mass 0.49 kg/m (the reading table copied into
 * tSlotFrameSeries.test.ts) × 0.75 m = 0.3675 kg = 367.5 g, shown with the BOM/cut-list display rule (two decimals below
 * 1000 g, bomTableRows.ts formatBomMass) as 367.50 g. The generic frame's mass comes from its volume and is checked by form only.
 */
const SERIES_MASS_TEXT = '367.50 g';
const MASS_FORM = /^[0-9]+\.[0-9]{2} (g|kg)$/u;
/** Family ids of the アルミフレーム category in registry order (registry/k6.ts) and their kind-name keys (ja/catalog.json). */
const FRAME_KINDS: readonly (readonly [string, string])[] = [
  ['t-slot-frame-specified', 'catalog.frame.kind.tSlotSpecified'], ['t-slot-frame-series', 'catalog.frame.kind.tSlotSeries'],
  ['angle-bracket-specified', 'catalog.frame.kind.angleBracket'], ['join-plate-specified', 'catalog.frame.kind.joinPlate'],
  ['slot-nut-specified', 'catalog.frame.kind.slotNut'],
  ['t-slot-frame-s6', 'catalog.frame.kind.tSlotS6'], ['t-slot-frame-s8', 'catalog.frame.kind.tSlotS8'],
  ['t-slot-frame-s10', 'catalog.frame.kind.tSlotS10'], ['aluminum-channel', 'catalog.frame.kind.channel'],
  ['aluminum-square-pipe', 'catalog.frame.kind.squarePipe'], ['aluminum-round-bar', 'catalog.frame.kind.roundBar'],
  ['aluminum-flat-bar', 'catalog.frame.kind.flatBar'], ['aluminum-angle', 'catalog.frame.kind.angle'],
  ['t-slot-nut-bar', 'catalog.frame.kind.nutBar'], ['t-slot-nut', 'catalog.frame.kind.catalogNut'],
  ['t-slot-round-nut', 'catalog.frame.kind.roundNut'], ['t-slot-frame-cap', 'catalog.frame.kind.cap'],
  ['t-slot-flat-plate', 'catalog.frame.kind.flatPlate'], ['t-slot-shaped-plate', 'catalog.frame.kind.shapedPlate'],
  ['t-slot-angle-bracket', 'catalog.frame.kind.angleBracketCatalog'], ['t-slot-foot-base', 'catalog.frame.kind.footBase'],
  ['t-slot-adjuster', 'catalog.frame.kind.adjuster'], ['pipe-frame', 'catalog.frame.kind.pipeFrame'],
  ['pipe-frame-slotted', 'catalog.frame.kind.pipeFrameSlotted'], ['pipe-frame-twin', 'catalog.frame.kind.pipeFrameTwin'],
  ['t-slot-frame-small', 'catalog.frame.kind.smallFrame'], ['t-slot-frame-cap-small', 'catalog.frame.kind.smallFrameCap'],
  ['bracket-stock', 'catalog.frame.kind.bracketStock'], ['pipe-frame-cap', 'catalog.frame.kind.pipeFrameCap'],
  ['pipe-frame-foot', 'catalog.frame.kind.pipeFrameFoot'],
];

function picker(page: Page): Locator {
  return page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });
}
export function choice(dialog: Locator, catalog: string, key: string): Locator {
  return dialog.getByRole('combobox', { name: uiMessage(catalog, key), exact: true });
}
/** Text fields are found by their visible label (the label also holds the unit), as in steelStockCsvFlow.ts. */
function fieldInput(dialog: Locator, key: string): Locator {
  return dialog.locator('label.pcad-field').filter({
    has: dialog.page().locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', key) }),
  }).locator('input');
}
function stockDetails(dialog: Locator): Locator {
  return dialog.locator('details').filter({
    has: dialog.page().locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.stock.title') }),
  });
}

export async function openFramePicker(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.placeStandardPart'));
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await choice(dialog, 'assembly', 'assembly.standardPart.category').selectOption('aluminumFrame');
  // The 呼び寸法 list appears once the family tables are loaded (catalog.mechanical.notLoaded before that).
  await expect(choice(dialog, 'assembly', 'assembly.standardPart.size')).toBeVisible();
  return dialog;
}

async function place(page: Page, dialog: Locator): Promise<void> {
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
}

/** The picker's cut list (linear family parts): header and the cells of every row. */
async function stockRows(dialog: Locator, count: number): Promise<string[][]> {
  const details = stockDetails(dialog);
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  await expect(details.locator('thead th')).toHaveText([uiMessage('catalog', 'catalog.stock.kind'),
    uiMessage('assembly', 'assembly.standardPart.size'), `${uiMessage('assembly', 'assembly.steel.stockLength')} (mm)`,
    uiMessage('assembly', 'assembly.steel.quantity'), `${uiMessage('assembly', 'assembly.steel.totalLength')} (mm)`,
    uiMessage('catalog', 'catalog.stock.mass')]);
  const rows = details.locator('tbody tr');
  await expect(rows).toHaveCount(count);
  return Promise.all((await rows.all()).map(row => row.locator('td').allTextContents()));
}

/** BOM rows (all cells) after the masses are shown; the series row's mass cell is the unit mass × length. */
async function bomRows(page: Page): Promise<string[][]> {
  await page.getByRole('group', { name: uiMessage('assembly', 'assembly.menu.build') })
    .getByRole('button', { name: uiMessage('assembly', 'assembly.tool.bom'), exact: true }).click();
  const headers = await page.locator('.pcad-bom__table thead th').allTextContents();
  const massColumn = headers.indexOf(uiMessage('assembly', 'assembly.bom.column.mass'));
  expect(massColumn, 'the BOM shows the mass column').toBeGreaterThanOrEqual(0);
  const rows = page.locator('.pcad-bom__table tbody tr.pcad-bom__row');
  await expect(rows).toHaveCount(2);
  const series = rows.filter({ hasText: '溝幅 6 20×20×750' });
  await expect(series.locator('td').nth(massColumn)).toHaveText(SERIES_MASS_TEXT);
  await expect(rows.filter({ hasText: '40角×500' }).locator('td').nth(massColumn)).toHaveText(MASS_FORM);
  return Promise.all((await rows.all()).map(row => row.locator('td').allTextContents()));
}

/** Kinds, refused impossible section, generic frame 500 and series 溝幅 6 20×20 750, all through the picker. */
async function placeFrames(page: Page): Promise<string[][]> {
  const dialog = await openFramePicker(page);
  const kind = choice(dialog, 'catalog', 'catalog.frame.kind');
  await expect(kind.locator('option')).toHaveText(FRAME_KINDS.map(([, key]) => uiMessage('catalog', key)));
  expect(await kind.locator('option').evaluateAll(options => options.map(option => option.getAttribute('value'))))
    .toEqual(FRAME_KINDS.map(([id]) => id));
  await expect(kind).toHaveValue('t-slot-frame-specified');
  await expect(dialog.getByText(uiMessage('catalog', 'catalog.frame.tSlot.hint'), { exact: true })).toBeVisible();

  // A slot opening as wide as the slot room (18) cannot be made: nothing is placed and the reason is shown.
  const opening = fieldInput(dialog, 'catalog.frame.option.slotOpening');
  await opening.fill('18');
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(uiMessage('catalog', 'catalog.mechanical.invalidOption'));
  await expect(opening).toHaveAttribute('aria-invalid', 'true');
  await expect(componentRows(page)).toHaveCount(0);

  await opening.fill('8');
  await fieldInput(dialog, 'catalog.mechanical.length').fill('500');
  await place(page, dialog);
  await expect(componentRows(page)).toHaveCount(1);
  const generic = await stockRows(dialog, 1);
  expect(generic[0]?.slice(0, 5)).toEqual([uiMessage('catalog', 'catalog.frame.kind.tSlotSpecified'), '寸法指定', '500', '1', '500']);
  expect(generic[0]?.[5]).toMatch(MASS_FORM);

  await kind.selectOption('t-slot-frame-series');
  const size = choice(dialog, 'assembly', 'assembly.standardPart.size');
  await size.selectOption('s6-20x20');
  await expect(size.locator('option:checked')).toHaveText(uiMessage('catalog', 'catalog.frame.row.series')
    .replace('{size}', '溝幅 6 20×20').replace('{opening}', '6').replace('{inner}', '12').replace('{mass}', '0.49'));
  await expect(dialog.getByText(uiMessage('catalog', 'catalog.frame.series.hint'), { exact: true })).toBeVisible();
  await fieldInput(dialog, 'catalog.mechanical.length').fill('750');
  await place(page, dialog);
  await expect(componentRows(page)).toHaveCount(2);
  const rows = await stockRows(dialog, 2);
  expect(rows[0]).toEqual(generic[0]);
  expect(rows[1]).toEqual([uiMessage('catalog', 'catalog.frame.kind.tSlotSeries'), '溝幅 6 20×20', '750', '1', '750', SERIES_MASS_TEXT]);
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return rows;
}

/** Web は保存の窓を消してから開き、Electron はそのまま。起動を待ち、空のアセンブリを新しく作る。 */
export async function startAssembly(page: Page, app: ElectronApplication | undefined): Promise<void> {
  if (app === undefined) {
    await disableFilePickers(page);
    await page.goto('/');
  } else {
    expect(page.url()).toBe('app://pointercad/index.html');
  }
  await waitForStartupReady(page);
  await resetAssemblyFileGateway(page);
  const start = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', uiMessage('assembly', 'assembly.file.new'));
  await waitForRecompute(page, start);
  await expect(componentRows(page)).toHaveCount(0);
}

/**
 * 予告の表の長さの列(線ごと)が `lengths` になるまで待って確かめる。角の扱いなどを替えた直後は行の数が同じまま中身だけが
 * 描き直されるので、1 回だけ読んで比べず、Playwright の待つ形で確かめる。
 */
export async function expectPreviewLengths(layout: Locator, lengths: readonly string[]): Promise<void> {
  await expect(layout.locator('tbody tr td:nth-child(2)')).toHaveText([...lengths]);
}

/**
 * J-01: 系列の溝幅 6 20×20 を、貼り付けた 500×300 の長方形(閉じる・突き当て)に沿って並べる。予告は 520・300・500・280
 * (先の線を通す。断面の半分 10 で伸び縮み。手で解いた値)、角 2 を入れ替えると 500・320・500・280。並べると 4 本・Undo 1 回で 0 本。
 */
async function layoutRectangle(page: Page): Promise<Locator> {
  const dialog = await openFramePicker(page);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
  const layout = dialog.locator('details').filter({
    has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
  });
  await layout.locator('summary').click();
  await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
    .fill(['0\t0\t0', '500\t0\t0', '500\t300\t0', '0\t300\t0'].join('\n'));
  await layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true }).check();
  await expect(layout.locator('tbody tr')).toHaveCount(4);
  await expectPreviewLengths(layout, ['520', '300', '500', '280']);
  const swap = layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.swap'), exact: true });
  await expect(swap).toHaveCount(4);
  await swap.nth(1).click();
  await expect(layout.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('320');
  await expectPreviewLengths(layout, ['500', '320', '500', '280']);
  await swap.nth(1).click();
  await expect(layout.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('300');
  const token = await beginRecompute(page);
  await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(layout.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameLayout.placed').replace('{count}', '4'));
  await expect(componentRows(page)).toHaveCount(4);
  return dialog;
}

export function registerAluminumFrameCatalogTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-06 アルミフレームの分類', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('族は5つ、作れない寸法は置かずに理由を出し、汎用のフレーム500と系列の溝幅6 20×20 750を置くと切断の一覧と部品表に出て、系列の質量は単位質量×長さ、保存と開き直しでも同じ', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);

      const stock = await placeFrames(page);
      const bom = await bomRows(page);
      const components = (await readAssemblyStats(page)).components.map(component => [component.id, component.name, component.sourceKind]);
      expect(components.map(([, , kind]) => kind)).toEqual(['standardPart', 'standardPart']);

      const savedPath = info.outputPath('aluminum-frames.pcada');
      await saveFlowFile(page, savedPath, app);
      await openSaveFlowFile(page, savedPath, app);
      await expect(componentRows(page)).toHaveCount(2);
      expect((await readAssemblyStats(page)).components.map(component => [component.id, component.name, component.sourceKind]))
        .toEqual(components);
      const reopened = await openFramePicker(page);
      expect(await stockRows(reopened, 2)).toEqual(stock);
      await reopened.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      expect(await bomRows(page)).toEqual(bom);
      expect(errors).toEqual([]);
    });

    test('J-01 線に沿って並べる: 貼り付けた長方形の点から予告(突き当て・通す線の入れ替え)を出して 4 本を並べ、切断の一覧に出て、Undo 1 回で戻り、やり直しと保存・開き直しで同じ', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);

      const dialog = await layoutRectangle(page);
      const stock = await stockRows(dialog, 4);
      expect(stock.map(row => row.slice(1, 5))).toEqual([
        ['溝幅 6 20×20', '520', '1', '520'], ['溝幅 6 20×20', '300', '1', '300'],
        ['溝幅 6 20×20', '500', '1', '500'], ['溝幅 6 20×20', '280', '1', '280']]);
      // J-01 包み 7: 定尺が空の間は割り付けず案内だけ。定尺 6000・切断代 3 を入れると、4 本は 1 本の棒に入る
      // (520 + 500 + 300 + 280 と切断代 3 × 3 = 1609、残り 4391、歩留まり 1600 ÷ 6000 = 26.7%。手で詰めた値)。
      const details = stockDetails(dialog);
      await expect(details.getByText(uiMessage('catalog', 'catalog.stockCutting.noStock'), { exact: true })).toBeVisible();
      const stockField = details.locator('label.pcad-field').filter({
        has: page.locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', 'catalog.stockCutting.stockLength') }),
      }).locator('input');
      const kerfField = details.locator('label.pcad-field').filter({
        has: page.locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', 'catalog.stockCutting.kerf') }),
      }).locator('input');
      await stockField.fill('6000');
      await kerfField.fill('3');
      const label = `${uiMessage('catalog', 'catalog.frame.kind.tSlotSeries')} 溝幅 6 20×20`;
      await expect(details.getByText(uiMessage('catalog', 'catalog.stockCutting.summary').replace('{label}', label).replace('{count}', '1')
        .replace('{yield}', '26.7'), { exact: true })).toBeVisible();
      await expect(details.getByText(uiMessage('catalog', 'catalog.stockCutting.bar').replace('{n}', '1')
        .replace('{cuts}', '520 + 500 + 300 + 280').replace('{offcut}', '4391'), { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      const placed = (await readAssemblyStats(page)).components;
      // 線 1 の部材は x = -10 から(断面の中心が線に乗り、先の線なので両端を 10 伸ばす)、線 4 の部材は y = 290 から。
      expect([placed[0]?.resolved?.position, placed[3]?.resolved?.position]).toEqual([[-10, 0, 0], [0, 290, 0]]);

      let token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(0);
      token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.redo'), exact: true }).click();
      await waitForRecompute(page, token);
      expect((await readAssemblyStats(page)).components).toEqual(placed);

      const savedPath = info.outputPath('frame-layout.pcada');
      await saveFlowFile(page, savedPath, app);
      await openSaveFlowFile(page, savedPath, app);
      await expect(componentRows(page)).toHaveCount(4);
      expect((await readAssemblyStats(page)).components.map(component => [component.id, component.name]))
        .toEqual(placed.map(component => [component.id, component.name]));
      expect(await stockRows(await openFramePicker(page), 4)).toEqual(stock);
      expect(errors).toEqual([]);
    });

    test('J-01 包み 4a 選んだ部品の辺から並べる: 箱を選んで辺を読み込むと 12 本の一覧が出て、上の面の 4 辺を選ぶと突き当ての 4 本を予告して並べられる', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const fixturePath = info.outputPath('two-box.pcada');
      await writeFile(fixturePath, await twoBoxAssemblyFile(40));
      await openSaveFlowFile(page, fixturePath, app);
      await expect(componentRows(page)).toHaveCount(2);
      await componentRows(page).nth(0).click();

      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      const layout = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
      });
      await layout.locator('summary').click();
      await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('edges');
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.loadEdges'), exact: true }).click();
      // 箱のまっすぐな辺は 12 本(独立の事実)。
      const edges = layout.getByRole('checkbox');
      await expect(edges).toHaveCount(12);
      // 上の面の 4 辺: 中点の Z が一番大きい行(行の文字の「中点 (x, y, z)」から読む)。
      const texts = await layout.locator('li').allInnerTexts();
      const z = texts.map(text => Number(/,\s*([-0-9.]+)\)\s*$/u.exec(text)?.[1] ?? Number.NaN));
      const top = Math.max(...z);
      const topIndexes = z.flatMap((value, index) => value === top ? [index] : []);
      expect(topIndexes).toHaveLength(4);
      for (const index of topIndexes) await edges.nth(index).check();
      // 箱の辺は 20 mm で、断面 20×20 の突き当て(半分 10 の伸び縮み)では、両端を当てる部材の長さが 0 になる(独立の計算)。
      // 作れない組は予告せず、線の番号つきの理由を出す。
      const edgeLengths = topIndexes.map(index => Number(/: ([0-9.]+) mm/u.exec(texts[index] ?? '')?.[1] ?? Number.NaN));
      expect(edgeLengths).toEqual([20, 20, 20, 20]);
      await expect(layout.getByRole('alert')).toHaveText(new RegExp(`^${uiMessage('catalog', 'catalog.frameLayout.error.nonPositiveLength')
        .replace('{line}', '[0-9]+').replace(/[()（）]/gu, '.')}$`, 'u'));
      await expect(layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true })).toBeDisabled();
      // 角の扱いを「そのまま」にすると、4 本とも辺の長さ 20 で予告する。
      await choice(layout, 'catalog', 'catalog.frameLayout.corners').selectOption('none');
      await expect(layout.locator('tbody tr')).toHaveCount(4);
      await expectPreviewLengths(layout, ['20', '20', '20', '20']);
      const token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(layout.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameLayout.placed').replace('{count}', '4'));
      await expect(componentRows(page)).toHaveCount(6);
      expect(errors).toEqual([]);
    });

    test('J-01 包み 4b 3D の画面で辺をクリックして選ぶ: 辺を読み込んだ後、画面の上の面の辺を押すと一覧のチェックが付き、もう一度押すと外れる', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const fixturePath = info.outputPath('two-box-pick.pcada');
      await writeFile(fixturePath, await twoBoxAssemblyFile(40));
      await openSaveFlowFile(page, fixturePath, app);
      await expect(componentRows(page)).toHaveCount(2);
      await goHome(page);
      await componentRows(page).nth(0).click();

      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      const layout = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
      });
      await layout.locator('summary').click();
      await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('edges');
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.loadEdges'), exact: true }).click();
      const edges = layout.getByRole('checkbox');
      await expect(edges).toHaveCount(12);
      // 一覧の行の「中点 (x, y, z)」(世界の座標)から、上の面の 4 辺の中点を読む。
      const texts = await layout.locator('li').allInnerTexts();
      const midpoints = texts.map((text): readonly [number, number, number] => {
        const match = /\(([-0-9.]+),\s*([-0-9.]+),\s*([-0-9.]+)\)\s*$/u.exec(text);
        return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
      });
      const top = Math.max(...midpoints.map(point => point[2]));
      const topIndexes = midpoints.flatMap((point, index) => point[2] === top ? [index] : []);
      expect(topIndexes).toHaveLength(4);
      const [first, second] = topIndexes;
      if (first === undefined || second === undefined) throw new Error('上の面の辺が 2 本ありません。');
      // 画面で上の面の辺 2 本の中点を押すと、その 2 行だけにチェックが付く(合致の打ちかけは始まらない)。
      for (const index of [first, second]) await clickWorldPointChecked(page, midpoints[index] ?? [0, 0, 0]);
      await expect(edges.nth(first)).toBeChecked();
      await expect(edges.nth(second)).toBeChecked();
      await expect(layout.getByRole('checkbox', { checked: true })).toHaveCount(2);
      // もう一度押すと外れる。
      await clickWorldPointChecked(page, midpoints[first] ?? [0, 0, 0]);
      await expect(edges.nth(first)).not.toBeChecked();
      await expect(layout.getByRole('checkbox', { checked: true })).toHaveCount(1);
      // 一覧のチェックと画面のクリックは同じチェックを入れ替える: 一覧で残りの 3 本を付けると 4 本になり、角を「そのまま」で 4 本を予告する。
      for (const index of topIndexes) if (index !== second) await edges.nth(index).check();
      await expect(layout.getByRole('checkbox', { checked: true })).toHaveCount(4);
      await choice(layout, 'catalog', 'catalog.frameLayout.corners').selectOption('none');
      await expect(layout.locator('tbody tr')).toHaveCount(4);
      await expectPreviewLengths(layout, ['20', '20', '20', '20']);
      expect(errors).toEqual([]);
    });

    test('J-01 包み 5 留め: 貼り付けた長方形を留めで並べると 4 本とも長い側 520・320 で、切断の一覧に留めの印が出て、保存・開き直しで同じ', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
      });
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
        .fill(['0\t0\t0', '500\t0\t0', '500\t300\t0', '0\t300\t0'].join('\n'));
      await layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true }).check();
      await choice(layout, 'catalog', 'catalog.frameLayout.corners').selectOption('miter');
      // 両方を相手の外の面まで 10 伸ばす(断面 20×20 の半分。手で解いた値)ので、長い側は外形 520×320 の辺の長さ。
      await expect(layout.locator('tbody tr')).toHaveCount(4);
      await expectPreviewLengths(layout, ['520', '320', '520', '320']);
      await expect(layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.swap'), exact: true })).toHaveCount(0);
      const token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(layout.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameLayout.placed').replace('{count}', '4'));
      await expect(componentRows(page)).toHaveCount(4);
      const note = uiMessage('catalog', 'catalog.stock.miterNote').replace('{count}', '2');
      const stock = await stockRows(dialog, 2);
      expect(stock.map(row => row.slice(1, 5))).toEqual([[`溝幅 6 20×20${note}`, '520', '2', '1040'], [`溝幅 6 20×20${note}`, '320', '2', '640']]);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();

      const savedPath = info.outputPath('frame-miter.pcada');
      await saveFlowFile(page, savedPath, app);
      await openSaveFlowFile(page, savedPath, app);
      await expect(componentRows(page)).toHaveCount(4);
      expect(await stockRows(await openFramePicker(page), 2)).toEqual(stock);
      expect(errors).toEqual([]);
    });

    test('J-01 包み 6 鋼材の留め: 平鋼 50×6 で貼り付けた長方形を留めで並べると 4 本とも長い側 550・350 で、鋼材の切断の一覧に留めの印が出る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.placeStandardPart'));
      const dialog = picker(page);
      await expect(dialog).toBeVisible();
      await dialog.getByTitle(uiMessage('assembly', 'assembly.guide.standardCategory'), { exact: true }).selectOption('structuralSection');
      await chooseSteelFlatBar50x6(dialog, { grade: 'SS400', size: 'FB 50×6', condition: '熱間圧延材・熱処理条件未指定' });
      const layout = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
      });
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
        .fill(['0\t0\t0', '500\t0\t0', '500\t300\t0', '0\t300\t0'].join('\n'));
      await layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true }).check();
      await choice(layout, 'catalog', 'catalog.frameLayout.corners').selectOption('miter');
      // 平鋼の幅 50 が枠の面の中に入るので、両方を相手の外の面まで 25 伸ばす(手で解いた値)。
      await expect(layout.locator('tbody tr')).toHaveCount(4);
      await expectPreviewLengths(layout, ['550', '350', '550', '350']);
      const token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(layout.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameLayout.placed').replace('{count}', '4'));
      await expect(componentRows(page)).toHaveCount(4);
      const stock = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('assembly', 'assembly.steel.stockList') }),
      });
      if (await stock.getAttribute('open') === null) await stock.locator('summary').click();
      const note = uiMessage('catalog', 'catalog.stock.miterNote').replace('{count}', '2');
      // 表は置いた後の組み直しで描き直されるので、行が出るのを待ってから読む(読む時の一瞬の空の表を拾わない)。
      await expect(stock.locator('tbody tr')).toHaveCount(2);
      await expect(stock.locator('tbody tr td:nth-child(2)')).toHaveText([`FB 50×6${note}`, `FB 50×6${note}`]);
      await expect(stock.locator('tbody tr td:nth-child(3)')).toHaveText(['550', '350']);
      expect(errors).toEqual([]);
    });

    test('J-01 包み 8 置いた後の一括の書き換え: 並べた 2 本を木で選び、長さを 600 に替えると切断の一覧が 600 × 2 になり、Undo 1 回で戻る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
      });
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
        .fill(['0\t0\t0', '500\t0\t0', '500\t300\t0'].join('\n'));
      await choice(layout, 'catalog', 'catalog.frameLayout.corners').selectOption('none');
      await expectPreviewLengths(layout, ['500', '300']);
      let token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(2);
      // 木で 2 本を選ぶ(2 本目は Shift で足す)。
      await componentRows(page).nth(0).click();
      await componentRows(page).nth(1).click({ modifiers: ['Shift'] });
      const bulk = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.memberBulk.title') }),
      });
      await bulk.locator('summary').click();
      await expect(bulk.getByText(uiMessage('catalog', 'catalog.memberBulk.hint').replace('{count}', '2'), { exact: true })).toBeVisible();
      // 欄は「名前・入力・単位(mm)」の 1 つの label なので、名前の文字で label を選んで入力を探す(選ぶ窓のほかの欄と同じ探し方)。
      await bulk.locator('label.pcad-field').filter({
        has: page.locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', 'catalog.memberBulk.length') }),
      }).locator('input').fill('600');
      token = await beginRecompute(page);
      await bulk.getByRole('button', { name: uiMessage('catalog', 'catalog.memberBulk.apply'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(bulk.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.memberBulk.applied').replace('{count}', '2'));
      expect((await stockRows(dialog, 1)).map(row => row.slice(1, 5))).toEqual([['溝幅 6 20×20', '600', '2', '1200']]);
      token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(2);
      expect((await stockRows(await openFramePicker(page), 2)).map(row => row.slice(1, 5)))
        .toEqual([['溝幅 6 20×20', '500', '1', '500'], ['溝幅 6 20×20', '300', '1', '300']]);
      expect(errors).toEqual([]);
    });

    test('2 部品の隙間: 離して置いた 2 本を木で選ぶと隙間(80)が出て測り直しが続かず、1 本に選び直すと消え、2 本に戻すとまた出る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = dialog.locator('details').filter({
        has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
      });
      await layout.locator('summary').click();
      const points = layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true });
      // 中心線を y 方向に 100 離した、x 方向の平行な 2 本。断面は 20 角(線を中心に ±10)なので、向かい合う面の隙間は
      // 100 − 20 = 80 になる(配置と断面の外形だけで決まる値)。
      for (const y of ['0', '100']) {
        await points.fill([`0\t${y}\t0`, `500\t${y}\t0`].join('\n'));
        await expectPreviewLengths(layout, ['500']);
        const token = await beginRecompute(page);
        await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
        await waitForRecompute(page, token);
      }
      await expect(componentRows(page)).toHaveCount(2);
      await componentRows(page).nth(0).click();
      await componentRows(page).nth(1).click({ modifiers: ['Shift'] });
      await expect.poll(() => readGap(page), { message: '2 部品を選ぶと隙間を測って出す' }).toBeCloseTo(80, 6);
      // 測り終えた後に測り直しの頼みが続かない(カーネルの待ちが 0 に戻る)。
      await waitForRecompute(page);
      await componentRows(page).nth(0).click();
      await expect.poll(() => readGap(page), { message: '1 部品に選び直すと隙間を消す' }).toBeNull();
      await componentRows(page).nth(1).click({ modifiers: ['Shift'] });
      await expect.poll(() => readGap(page), { message: '2 部品に戻すとまた測って出す' }).toBeCloseTo(80, 6);
      await waitForRecompute(page);
      expect(errors).toEqual([]);
    });
  });
}

/** 検査の口 pcadAssemblyStats の 2 部品の隙間(mm)。出ていなければ null。欄が無い時は理由を出して落とす。 */
async function readGap(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadAssemblyStats');
    if (typeof read !== 'function') throw new Error('検査専用の口 pcadAssemblyStats が見つかりません。');
    const stats: unknown = Reflect.apply(read, window, []);
    if (typeof stats !== 'object' || stats === null || !('gapMm' in stats)) throw new Error('検査の口に隙間の欄(gapMm)がありません。');
    const gap: unknown = stats.gapMm;
    return typeof gap === 'number' ? gap : null;
  });
}
