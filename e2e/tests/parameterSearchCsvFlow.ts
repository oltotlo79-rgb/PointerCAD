import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * R12(パラメータの検索と参照の絞込)・R13(パラメータの CSV 入出力と適用前の確認)の実画面の流れ。
 * Web(Chromium・Firefox。実ファイル選択とダウンロード)と実 Electron(ダイアログの差し替え)で同じ手順を通す。
 * 受入条件の正本は docs/plans/review-2026-10-04-response.md の R12・R13。
 */

/** ファイルの出し入れ。環境ごとの違い(ファイル選択とダイアログ)だけをここへ分ける。 */
export interface ParameterCsvIo {
  /** 「CSVを読み込む」を押し、指したファイルを選ばせる。 */
  readonly importFile: (page: Page, button: Locator, path: string) => Promise<void>;
  /** 「CSVを書き出す」を押し、書き出された中身を返す。 */
  readonly exportFile: (page: Page, button: Locator, path: string) => Promise<Buffer>;
}

export const SEARCH_LIMIT_MS = 100;

interface Row { readonly name: string; readonly source: string; readonly unit: string; readonly description: string }

const pad = (value: number): string => String(value).padStart(3, '0');

/** 100 行。日本語の名前・式・説明・単位、引用符とカンマと改行、他の行の参照を含む。 */
function hundredRows(): readonly Row[] {
  return Array.from({ length: 100 }, (_, index): Row => {
    const n = index + 1;
    const name = `寸法${pad(n)}`;
    let source = String(10 + n);
    if (n >= 61 && n <= 90) source = `寸法${pad(n - 60)} + 1`;
    if (n >= 91 && n <= 95) source = '寸法061 * 2';
    let description = n % 2 === 1 ? `基準寸法 ${String(n)}` : `補助寸法 ${String(n)}`;
    if (n === 5) description = '基準 "A", 板厚';
    if (n === 7) description = '基準\n改行';
    if (n === 10) description = '補助 ABC xyz';
    return { name, source, unit: n === 100 ? 'degree' : 'mm', description };
  });
}

const quote = (cell: string): string => /[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
/** アプリの書出と同じ並び(見出し・CRLF)で組む。往復の一致をバイトで確かめるため。 */
function csvOf(rows: readonly Row[]): string {
  return ['name,expression,unit,description', ...rows.map(row =>
    [row.name, row.source, row.unit, row.description].map(quote).join(','))].join('\r\n') + '\r\n';
}

/** Independent byte oracle for the explicitly marked safe export, not the production codec. */
function safeExportCsvOf(rows: readonly Row[]): string {
  return String.fromCharCode(0xfeff)
    + ['name,expression,unit,description,textEncoding', ...rows.map(row =>
      [row.name, row.source, row.unit, row.description, 'pointercad-text-v1']
        .map(quote).join(','))].join('\r\n') + '\r\n';
}

async function writeCsv(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { flag: 'w' });
}

/** 検索が名前と説明の両方・大文字小文字を区別せずに当たる、という期待を画面と別に書き下したもの。 */
function expectedNames(rows: readonly Row[], query: string, only?: ReadonlySet<string>): string[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (only === undefined || only.has(row.name))
    && (needle === '' || row.name.toLocaleLowerCase().includes(needle)
      || row.description.toLocaleLowerCase().includes(needle))).map(row => row.name);
}

const panel = (page: Page): Locator => page.locator('.pcad-panel--right');
const search = (page: Page): Locator => panel(page).getByRole('searchbox', { name: '名前・説明を検索' });
const filterButton = (page: Page, label: string): Locator =>
  panel(page).getByRole('group', { name: '表示する係数' }).getByRole('button', { name: label, exact: true });
const importButton = (page: Page): Locator => panel(page).getByRole('button', { name: 'CSVを読み込む', exact: true });
const exportButton = (page: Page): Locator => panel(page).getByRole('button', { name: 'CSVを書き出す', exact: true });
const preview = (page: Page): Locator => panel(page).getByRole('region', { name: '変更の確認' });
const undoButton = (page: Page): Locator => page.getByRole('button', { name: '元に戻す', exact: true });
const redoButton = (page: Page): Locator => page.getByRole('button', { name: 'やり直す', exact: true });
const resultCount = (page: Page): Locator => panel(page).locator('p[role="status"]').filter({ hasText: '検索結果' });

interface ShownRow { readonly name: string; readonly source: string; readonly description: string }
/** 画面に出ている行を表示順に読む(名前・式・説明の 3 つの欄)。 */
async function shownRows(page: Page): Promise<ShownRow[]> {
  return panel(page).locator('.pcad-parameter').evaluateAll(elements => elements.map(element => {
    const inputs = Array.from(element.querySelectorAll<HTMLInputElement>('.pcad-field input'));
    return { name: inputs[0]?.value ?? '', source: inputs[1]?.value ?? '', description: inputs[2]?.value ?? '' };
  }));
}
const shownNames = async (page: Page): Promise<string[]> => (await shownRows(page)).map(row => row.name);
/** 入力欄は改行を持てない。画面側の値は改行を除いたものになる。 */
const flat = (text: string): string => text.replaceAll(/[\r\n]/gu, '');

async function expectNames(page: Page, expected: readonly string[], message: string): Promise<void> {
  await expect.poll(() => shownNames(page), { message }).toEqual(expected);
}

async function expectAllRows(page: Page, rows: readonly Row[], message: string): Promise<void> {
  await expect(panel(page).locator('.pcad-parameter'), message).toHaveCount(rows.length);
  expect(await shownRows(page), message).toEqual(rows.map(row =>
    ({ name: row.name, source: row.source, description: flat(row.description) })));
}

/** 検索語を入れてから結果の件数が出るまでを、画面の中で performance.now で測る。 */
async function timedSearch(page: Page, query: string, total: number, expectedCount: number): Promise<number> {
  return search(page).evaluate((input: HTMLInputElement, args) => new Promise<number>((resolve, reject) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) { reject(new Error('value setter')); return; }
    const wanted = `検索結果 ${String(args.count)} / ${String(args.total)}`;
    const matched = (): boolean => Array.from(document.querySelectorAll('p[role="status"]'))
      .some(node => (node.textContent ?? '').replaceAll(/\s+/gu, ' ').trim() === wanted);
    const start = performance.now();
    setter.call(input, args.query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const tick = (): void => {
      if (matched()) { resolve(performance.now() - start); return; }
      if (performance.now() - start > 5000) { reject(new Error(`検索結果の表示が出ません: ${wanted}`)); return; }
      requestAnimationFrame(tick);
    };
    tick();
  }), { query, total, count: expectedCount });
}

/**
 * パラメータ表へ入る。Web は呼び出し側で起動を済ませておくこと。
 */
export async function parameterSearchCsvFlow(page: Page, info: TestInfo, io: ParameterCsvIo): Promise<void> {
  const evidenceDir = fileURLToPath(new URL('../../scratchpad/claude/agents/cl-v103-w16-params', import.meta.url));
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = hundredRows();
  const originalPath = info.outputPath('parameters-100.csv');
  await writeCsv(originalPath, csvOf(rows));
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await expect(panel(page)).toContainText('名前を付けた数値はまだありません。');
  await expect(undoButton(page)).toBeDisabled();

  // 1) 100 行の CSV を読む。適用前の確認は 100 行の「追加」。取り消すと文書も履歴も変わらない。
  await io.importFile(page, importButton(page), originalPath);
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator('li')).toHaveCount(100);
  await expect(preview(page).getByText('追加', { exact: false }).first()).toBeVisible();
  await expect(panel(page).locator('.pcad-parameter')).toHaveCount(0);
  await preview(page).getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(preview(page)).toHaveCount(0);
  await expect(panel(page)).toContainText('名前を付けた数値はまだありません。');
  await expect(undoButton(page), '取消では履歴が増えない').toBeDisabled();

  // 2) もう一度読み、適用する。100 行が元の順で入り、元に戻すは 1 回で空へ戻る。
  await io.importFile(page, importButton(page), originalPath);
  await expect(preview(page).locator('li')).toHaveCount(100);
  await preview(page).getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(panel(page).getByText('CSVの変更を適用しました。')).toBeVisible();
  await expectAllRows(page, rows, 'CSV の 100 行が名前・式・説明の通りに入る');
  await undoButton(page).click();
  await expect(panel(page).locator('.pcad-parameter'), '適用は 1 回の元に戻すで全部戻る').toHaveCount(0);
  await expect(undoButton(page)).toBeDisabled();
  await redoButton(page).click();
  await expectAllRows(page, rows, 'やり直しで 100 行が戻る');

  // 3) 検索 10 回。名前と説明に当たり、各回 100ms 未満で、出る行が期待の集合に完全一致する。
  const queries = ['寸法07', '基準', '補助', 'abc', '寸法100', '1', '"A"', '板厚', '寸法0 1', '該当なし'];
  const timings: { query: string; ms: number; count: number }[] = [];
  const input = search(page);
  for (const query of queries) {
    const expected = expectedNames(rows, query);
    const ms = await timedSearch(page, query, 100, expected.length);
    timings.push({ query, ms: Math.round(ms * 100) / 100, count: expected.length });
    await expectNames(page, expected, `検索「${query}」の行の集合`);
    if (expected.length === 0) await expect(panel(page)).toContainText('一致する係数がありません。検索語または表示条件を変えてください。');
  }
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/search-timing-${info.project.name}.json`,
    JSON.stringify({ project: info.project.name, limitMs: SEARCH_LIMIT_MS, timings }, null, 2));
  for (const timing of timings) {
    expect(timing.ms, `検索「${timing.query}」は ${String(SEARCH_LIMIT_MS)}ms 未満`).toBeLessThan(SEARCH_LIMIT_MS);
  }
  await input.fill('');

  // 4) 3 つの絞込。「未使用」「参照元あり」は期待の集合に完全一致、「循環」は 0 件で理由を示す。検索語とは AND。
  const referenced = new Set<string>([...Array.from({ length: 30 }, (_, i) => `寸法${pad(i + 1)}`), '寸法061']);
  const unused = new Set(rows.map(row => row.name).filter(name => !referenced.has(name)));
  await filterButton(page, '未使用').click();
  await expect(filterButton(page, '未使用')).toHaveAttribute('aria-pressed', 'true');
  await expectNames(page, expectedNames(rows, '', unused), '未使用の集合');
  await expect(resultCount(page)).toContainText(`検索結果 ${String(unused.size)} / 100`);
  await input.fill('補助');
  await expectNames(page, expectedNames(rows, '補助', unused), '未使用と検索語の AND');
  await input.fill('');
  await filterButton(page, '参照元あり').click();
  await expectNames(page, expectedNames(rows, '', referenced), '参照元ありの集合');
  await expect(resultCount(page)).toContainText('検索結果 31 / 100');
  await input.fill('基準');
  await expectNames(page, expectedNames(rows, '基準', referenced), '参照元ありと検索語の AND');
  await input.fill('');
  await filterButton(page, '循環').click();
  await expect(panel(page).locator('.pcad-parameter')).toHaveCount(0);
  await expect(panel(page)).toContainText('一致する係数がありません。検索語または表示条件を変えてください。');
  await filterButton(page, 'すべて').click();
  await expectNames(page, rows.map(row => row.name), 'すべて');

  // 5) 検索中の改名・元に戻す・構成の切替で、検索語と焦点が消えない。
  await input.fill('基準');
  const shown = expectedNames(rows, '基準');
  await expectNames(page, shown, '基準で絞る');
  const first = panel(page).locator('.pcad-parameter').first();
  await first.locator('.pcad-field').nth(0).locator('input').fill('基準寸法A');
  await first.locator('.pcad-field').nth(0).locator('input').press('Enter');
  await expect(input).toBeEnabled();
  await expect(input, '改名の後も検索語が残る').toHaveValue('基準');
  expect(await page.evaluate(() => document.activeElement?.tagName), '改名の後も焦点が文書の外へ落ちない').not.toBe('BODY');
  await expectNames(page, ['基準寸法A', ...shown.slice(1)], '改名した行が同じ位置に出る');
  await undoButton(page).click();
  await expect(input).toHaveValue('基準');
  await expectNames(page, shown, '元に戻すで名前が戻り、検索語は残る');
  expect(await page.evaluate(() => document.activeElement?.tagName), '元に戻すの後も焦点が文書の外へ落ちない').not.toBe('BODY');

  const config = panel(page).getByRole('region', { name: '構成' });
  const configName = config.getByRole('textbox', { name: '構成の名前' });
  const configSelect = config.getByRole('combobox', { name: '構成' });
  const sourceOf = (): Locator => panel(page).locator('.pcad-parameter').first().locator('.pcad-field').nth(1).locator('input');
  await input.fill('寸法002');
  const addConfig = async (name: string): Promise<void> => {
    await configName.fill(name); await config.getByRole('button', { name: '追加', exact: true }).click();
    await expect(configSelect.locator('option', { hasText: name })).toHaveCount(1);
    await expect(configName).toHaveValue('');
  };
  const choose = async (name: string): Promise<void> => {
    await configSelect.focus();
    await configSelect.selectOption({ label: name });
    await expect(configSelect.locator('option:checked')).toHaveText(name);
    await expect(input, `構成「${name}」へ切り替えた後も検索語が残る`).toHaveValue('寸法002');
    await expectNames(page, ['寸法002'], `構成「${name}」でも検索結果は同じ`);
    await expect(configSelect, '構成の切替の後も操作した欄に焦点が残る').toBeFocused();
  };
  await addConfig('案A');
  await expect(input, '構成の追加の後も検索語が残る').toHaveValue('寸法002');
  await addConfig('案B');
  await expectNames(page, ['寸法002'], '構成を足しても検索結果は同じ');
  await choose('案A');
  await sourceOf().fill('77'); await sourceOf().press('Enter');
  await expect(sourceOf()).toHaveValue('77');
  await choose('案B');
  await expect(sourceOf(), '案B の式は案A の編集の影響を受けない').toHaveValue('12');
  await sourceOf().fill('88'); await sourceOf().press('Enter');
  await expect(sourceOf()).toHaveValue('88');
  await choose('案A');
  await expect(sourceOf(), '案A の式').toHaveValue('77');
  await choose('案B');
  await expect(sourceOf(), '案B の式').toHaveValue('88');
  await input.fill('');

  // 6) 読込で一部を変える CSV は、適用前に「更新 2・追加 1・変更なし 98」と出る。取り消すと値は動かない。
  //    適用すると 1 回の元に戻すで元の表へ戻る。(構成の確認の影響を避けるため、構成は 2 つ戻して空の文書で行う。)
  while (await undoButton(page).isEnabled()) await undoButton(page).click();
  await expect(panel(page).locator('.pcad-parameter')).toHaveCount(0);
  await redoButton(page).click();
  await expectAllRows(page, rows, '履歴の底から 1 つ進めると CSV の 100 行');
  const changed: Row[] = rows.map(row => row.name === '寸法098' ? { ...row, source: '66' }
    : row.name === '寸法099' ? { ...row, source: '55' } : row);
  const extra: Row = { name: '追加寸法', source: '寸法001 + 寸法002', unit: 'mm', description: '新しい行' };
  const changedPath = info.outputPath('parameters-changed.csv');
  await writeCsv(changedPath, csvOf([...changed, extra]));
  await io.importFile(page, importButton(page), changedPath);
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator('li')).toHaveCount(101);
  await expect(preview(page).locator('li', { hasText: '追加寸法' })).toContainText('追加');
  await expect(preview(page).locator('li', { hasText: '寸法099' })).toContainText('更新');
  await preview(page).getByRole('button', { name: '取り消す', exact: true }).click();
  await expectAllRows(page, rows, '取消では表が変わらない');
  await io.importFile(page, importButton(page), changedPath);
  await preview(page).getByRole('button', { name: '変更を適用', exact: true }).click();
  await expect(panel(page).locator('.pcad-parameter')).toHaveCount(101);
  await undoButton(page).click();
  await expectAllRows(page, rows, '適用は 1 回の元に戻すで適用前へ戻る');

  // 7) 安全な文字形式の全バイトを独立照合し、空の表への再読込で100行の原文も照合する。
  const exportedPath = info.outputPath('parameters-exported.csv');
  const exported = await io.exportFile(page, exportButton(page), exportedPath);
  expect(exported.toString('utf8')).toBe(safeExportCsvOf(rows));
  await expect(panel(page).getByText('CSVを書き出しました。')).toBeVisible();
  while (await undoButton(page).isEnabled()) await undoButton(page).click();
  await expect(panel(page).locator('.pcad-parameter')).toHaveCount(0);
  await io.importFile(page, importButton(page), exportedPath);
  await preview(page).getByRole('button', { name: '変更を適用', exact: true }).click();
  await expectAllRows(page, rows, '書き出した CSV を読み戻すと 100 行が同じ');
  const again = await io.exportFile(page, exportButton(page), info.outputPath('parameters-exported-2.csv'));
  expect(again.equals(exported), '2 回目の書出も同じバイト列').toBe(true);

  // 8) 上限。1000 行と 1MiB は通り、1001 行と 1MiB+1 バイトは理由つきで断られて文書は変わらない。
  const many = (count: number, tail = ''): Row[] => Array.from({ length: count }, (_, index) =>
    ({ name: `上限${pad(index + 1)}`, source: String(index + 1), unit: 'mm', description: index === count - 1 ? tail : '上限' }));
  const thousandPath = info.outputPath('parameters-1000.csv');
  await writeCsv(thousandPath, csvOf(many(1000)));
  await io.importFile(page, importButton(page), thousandPath);
  await expect(preview(page).locator('li')).toHaveCount(1000, { timeout: 60_000 });
  await preview(page).getByRole('button', { name: '取り消す', exact: true }).click();
  await expectAllRows(page, rows, '1000 行の確認を取り消しても表は同じ');

  const overRowsPath = info.outputPath('parameters-1001.csv');
  await writeCsv(overRowsPath, csvOf(many(1001)));
  await io.importFile(page, importButton(page), overRowsPath);
  await expect(panel(page).getByRole('alert')).toContainText('CSVは1000行までです。');
  await expect(preview(page)).toHaveCount(0);
  await expectAllRows(page, rows, '1001 行は断られて表が同じ');

  const exactText = (target: number): string => {
    const base = csvOf(many(900, 'x'));
    const padding = target - Buffer.byteLength(base, 'utf8');
    return csvOf(many(900, 'x'.repeat(1 + padding)));
  };
  const mebibyte = 1_048_576;
  const exactBody = exactText(mebibyte);
  expect(Buffer.byteLength(exactBody, 'utf8')).toBe(mebibyte);
  const exactPath = info.outputPath('parameters-1mib.csv');
  await writeCsv(exactPath, exactBody);
  await io.importFile(page, importButton(page), exactPath);
  await expect(preview(page).locator('li')).toHaveCount(900, { timeout: 60_000 });
  await preview(page).getByRole('button', { name: '取り消す', exact: true }).click();

  const overBody = exactText(mebibyte + 1);
  expect(Buffer.byteLength(overBody, 'utf8')).toBe(mebibyte + 1);
  const overPath = info.outputPath('parameters-1mib-plus-1.csv');
  await writeCsv(overPath, overBody);
  await io.importFile(page, importButton(page), overPath);
  await expect(panel(page).getByRole('alert')).toContainText('ファイルが大きすぎるため開けません。');
  await expect(preview(page)).toHaveCount(0);
  await expectAllRows(page, rows, '1MiB+1 は断られて表が同じ');
}
