/// <reference lib="dom" />
import { readFileSync, writeFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';

/**
 * P6(入出力)の完了条件のうち、**ファイルの往復**を実際のブラウザで通しで確かめる
 * (要件 `docs/requirements.md` §9 P6、計画書 `docs/plans/P6-入出力.md` §0.59、タスク44)。
 *
 * ここで固定するのは §0.59 の (a)〜(d):
 *  - (a) 箱 → STEP で書き出す → 読み込む → **体積が一致する**
 *  - (b) 箱 → STL(バイナリ)で書き出す → 読み込む → **三角形 12 枚・体積 8000**
 *  - (c) inch の STEP を読み込む → **寸法が 25.4 倍**(体積は 25.4³ 倍)で入る
 *  - (d) DXF(線と円弧)を読み込む → スケッチに線分と円弧ができる → **押し出せる**
 *
 * **(e)「スケッチ → DXF 書き出し → 読み直すと同じ形」はここに無い。** 2026-09-06 の実測で、
 * DXF を**書き出す入口が画面に 1 つも無い**(`model` の `sketchToDxf` と `io` の `writeDxf` は
 * 在るが、`packages/ui` からそれを呼ぶ配線が無く、書き出しのパネルの形式も STEP / STL /
 * 3MF / OBJ / glTF の 5 つだけ)。**この検査からは直せない**(担当の範囲外)ので、
 * 統括へ報告して配線が入ってから足す。
 *
 * **ファイルのバイト列はすべてこの検査の中で組む**(見本のファイルを追跡対象に増やさない。
 * `rules/03-品質ゲート.md` §7.1 #0)。書き出したものは Playwright の作業用の場所
 * (`testInfo.outputPath`)へ落とし、読み込みでそのまま使う。
 *
 * 補助関数は既存の E2E(`p5-primitive-pick.spec.ts` / `p4b-parameters.spec.ts`)と同じ作りで
 * 書き写す(P1 からの作りに合わせる)。**再計算の待ちだけは共有の `recompute.ts` を使う**
 * (写しが 6 本目になるため。統括の判断 2026-09-06)。選択子は `data-testid` を足さず
 * role / aria / class で引く。**ヘッドレスで実行する。**
 */

/** 既定の箱の 1 辺(`packages/model/src/part/createPartDocument.ts` の DEFAULT_BOX_SIZE_MM)。 */
const BOX_SIZE_MM = 20;
/** 既定の箱の体積。中心が原点なので各軸 −10〜+10 に広がる。 */
const BOX_VOLUME = BOX_SIZE_MM ** 3;
/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';
/** 国際インチの定義値(`packages/model` の MM_PER_INCH と同じ数)。 */
const MM_PER_INCH = 25.4;

/* ========================================================================== *
 * 補助関数(p5-primitive-pick.spec.ts / p4b-parameters.spec.ts と同じ作り)
 * ========================================================================== */

function collectErrors(page: Page): readonly string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

/**
 * File System Access API を無いことにしてから頁を開く(§0.a-0.10)。
 * ヘッドレスでは OS の窓を操作できないので、**ダウンロードとファイル選択の代替経路**へ落とす。
 * こうすると書き出しは `download` の知らせ、読み込みは `filechooser` の知らせで捕まえられる。
 */
async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });
}

function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

function toolMenuTrigger(page: Page, menu: string): Locator {
  return page
    .locator('.pcad-toolbar')
    .getByRole('button', { name: new RegExp(`^${menu}`) })
    .first();
}

function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('group', { name: menu, exact: true });
}

async function openToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) === 0) {
    await toolMenuTrigger(page, menu).click();
  }
  await expect(toolMenuPanel(page, menu)).toBeVisible();
}

function menuTool(page: Page, menu: string, label: string): Locator {
  return toolMenuPanel(page, menu).getByRole('button', { name: label, exact: true });
}

/** 「ファイル」の畳んだ一覧(書き出す・読み込む・ひな形・印刷)から 1 行を押す。 */
async function chooseFileMenu(page: Page, label: string): Promise<void> {
  await openToolMenu(page, 'ファイルのほかの操作');
  await menuTool(page, 'ファイルのほかの操作', label).click();
}

function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

async function fillFields(page: Page, sources: readonly string[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    await inputs.nth(index).fill(source);
  }
}

async function commitPopover(page: Page): Promise<void> {
  await expect(popover(page)).toBeVisible();
  await popoverInputs(page).first().press('Enter');
}

async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) {
    return;
  }
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

/** 「ソリッド」節の中の立体の行。読み込んだ形もここに並ぶ。 */
function solidRows(page: Page): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__row--child');
}

/**
 * 「ソリッド」節を開く。**畳んでいると中の行が 1 つも描かれない**ので、行を数える前に必ず通す
 * (P6 タスク45 の担当が見つけた落とし穴、2026-09-06)。
 */
async function openSolidSection(page: Page): Promise<void> {
  const header = treeSection(page, 'ソリッド').locator('.pcad-tree__row--section').first();
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) === 'false') {
    await header.click();
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/** 見出しが完全に一致する行だけを引く(「単位」のように短い見出し用)。 */
function exactPropertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: new RegExp(`^${key}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

/**
 * 節を見出しで絞ってから鍵と値を引く。
 *
 * 読み込んだ三角形の形(STL / OBJ / 3MF / glTF)は「対象」の節と「結果」の節の**両方**に
 * 「体積」「三角形の数」の行を持つ(2026-09-06 実測)ので、節を絞らないと 2 つに当たる。
 * 実際の値が入るのは**「対象」の節**のほうで、「結果」の節は「計算できていません」と出る
 * (読み込んだ三角形は履歴の段として作り直す形を持たないため。統括へ報告した見た目の傷)。
 */
function sectionPropertyValue(page: Page, section: string, key: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-section')
    .filter({ has: page.locator('.pcad-section__title', { hasText: new RegExp(`^${section}$`) }) })
    .locator('dt.pcad-properties__key', { hasText: new RegExp(`^${key}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

/** プロパティに出ている体積を数で読む。まだ出ていなければ NaN。 */
async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) {
    return Number.NaN;
  }
  return Number.parseFloat(await cell.innerText());
}

/** 体積が期待どおりになるまで待つ(相対の許容差で比べる)。 */
async function expectVolumeNear(
  page: Page,
  expected: number,
  relativeTolerance: number,
): Promise<void> {
  await expect
    .poll(async () => Math.abs((await volumeNumber(page)) - expected) / expected, {
      timeout: KERNEL_TIMEOUT_MS,
      message: `体積が ${String(expected)} mm³ に相対 ${String(relativeTolerance)} 以内で一致すること`,
    })
    .toBeLessThanOrEqual(relativeTolerance);
}

/** 「作る」の一覧から基本形状の箱を、既定の 20×20×20 のまま原点へ置く(FR-429)。 */
async function placeBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '箱').click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await expect(popoverInputs(page).nth(0)).toHaveValue(String(BOX_SIZE_MM));
  await commitPopover(page);
  await cancelPopover(page);
  await openSolidSection(page);
  await solidRows(page).first().click();
  await waitForRecompute(page);
  await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
}

/** 書き出しのパネル(その場に浮かぶ 1 枚)。 */
function exchangePanel(page: Page): Locator {
  return page.locator('.pcad-exchange');
}

/**
 * 形式を選んで書き出し、落ちてきたファイルを保存してバイト列を返す。
 *
 * 書き出しは `<a download>` で始まるので、**押す前に `download` の待ちを仕掛ける**
 * (押してから待つと、押した瞬間の知らせを取りこぼす)。
 */
async function exportShape(page: Page, format: string, savePath: string): Promise<Uint8Array> {
  await chooseFileMenu(page, '書き出す');
  const panel = exchangePanel(page);
  await expect(panel).toBeVisible();
  await panel.getByRole('radio', { name: format, exact: true }).click();
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: '書き出す', exact: true }).click();
  await (await download).saveAs(savePath);
  await expect(panel).toHaveCount(0);
  return new Uint8Array(readFileSync(savePath));
}

/**
 * ファイルを読み込む。読み込みは `<input type="file">` で始まるので `filechooser` で答える
 * (**こちらも押す前に待ちを仕掛ける**。P6 タスク45 の担当が見つけた落とし穴 2 つ目)。
 */
async function importFile(page: Page, path: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await chooseFileMenu(page, '読み込む');
  await (await chooser).setFiles(path);
}

/** 単位を訊く小窓(STL / OBJ / 単位の無い DXF のときだけ出る)で「ミリメートル」を選ぶ。 */
async function answerMillimetre(page: Page): Promise<void> {
  const panel = page.locator('.pcad-import-unit');
  await expect(panel).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await panel.getByRole('button', { name: 'ミリメートル', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

/* ========================================================================== *
 * 見本のファイルをこの場で組む(追跡ファイルを増やさない)
 * ========================================================================== */

/**
 * mm で書かれた STEP を、**同じ座標のまま inch の STEP へ書き換える**(§0.59 の (c))。
 *
 * STEP は「長さの単位」を 1 つの実体で表しており、形の座標はその単位の数として書かれている。
 * だから**長さの単位の実体だけを差し替えれば**、座標を 1 文字も触らずに「同じ数だが inch」の
 * ファイルになり、読み込むと 25.4 倍の大きさで入るはずである。差し替え先は OCCT 自身が
 * `write.step.unit = INCH` で書くのと同じ形(`packages/kernel/src/occt/readStep.test.ts` の
 * `inchStep` の実測)にそろえてある。
 *
 * 複合の実体(丸かっこで並べる書き方)の中の型の名前は**辞書順**に並べる決まりなので、
 * `CONVERSION_BASED_UNIT` → `LENGTH_UNIT` → `NAMED_UNIT` の順で書く。
 * 足す 3 実体の番号は、書き出されたファイルの番号(実測で 400 未満)とぶつからない大きな数にする。
 */
function toInchStep(stepBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(stepBytes);
  const pattern = /#(\d+) = \( LENGTH_UNIT\(\) NAMED_UNIT\(\*\) SI_UNIT\(\.MILLI\.,\.METRE\.\) \);/;
  const found = pattern.exec(text);
  if (found === null) {
    throw new Error('書き出した STEP の中に mm の長さの単位が見つかりませんでした。');
  }
  const exponents = '#900001';
  const measure = '#900002';
  const millimetre = '#900003';
  const replaced = text.replace(
    pattern,
    [
      `#${found[1]} = ( CONVERSION_BASED_UNIT('INCH',${measure}) LENGTH_UNIT() NAMED_UNIT(${exponents}) );`,
      `${exponents} = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);`,
      `${measure} = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${String(MM_PER_INCH)}),${millimetre});`,
      `${millimetre} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`,
    ].join('\n'),
  );
  return new TextEncoder().encode(replaced);
}

/** DXF のタグ 1 つ(グループコードの行と値の行)。 */
type DxfTagInput = readonly [number, string];

/** タグの列を DXF のテキストへ組む(改行は DXF の慣習どおり `\r\n`)。 */
function formatDxf(tags: readonly DxfTagInput[]): string {
  return tags.map(([code, value]) => `${String(code)}\r\n${value}\r\n`).join('');
}

/** 半円の直径(mm)。線分 1 本と円弧 1 つで閉じた「D」の形になる。 */
const DXF_RADIUS_MM = 10;

/**
 * 線分 1 本と円弧 1 つでできた閉じた図形の DXF を組む(§0.59 の (d))。
 *
 * - `LINE` : (−10, 0) → (+10, 0)
 * - `ARC`  : 中心 (0, 0)、半径 10、0 度 → 180 度(DXF の円弧は必ず反時計回り)
 *
 * 2 つで半円が閉じるので、そのまま面を張って押し出せる。
 * `$INSUNITS = 4`(mm)を書いておくと、読み込みで単位を訊かれない(計画書 §0.a-0.6)。
 */
function halfDiscDxf(): string {
  const radius = String(DXF_RADIUS_MM);
  return formatDxf([
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$INSUNITS'],
    [70, '4'],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    [0, 'LINE'],
    [8, '0'],
    [10, `-${radius}`],
    [20, '0'],
    [30, '0'],
    [11, radius],
    [21, '0'],
    [31, '0'],
    [0, 'ARC'],
    [8, '0'],
    [10, '0'],
    [20, '0'],
    [30, '0'],
    [40, radius],
    [50, '0'],
    [51, '180'],
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]);
}

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P6 ファイルの往復(要件§9 P6、計画書 §0.59)', () => {
  /* 窓の大きさは既存の E2E と同じ 1440×900 に固定する(ツールバーの畳み方が幅で変わるため)。 */
  test.use({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });

  test('(a) 箱を STEP で書き出して読み込むと、体積が一致する(FR-803、FR-802)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await placeBox(page);

    const stepPath = testInfo.outputPath('exchange-a.step');
    const bytes = await exportShape(page, 'STEP', stepPath);
    // 先頭の 12 バイトは STEP の名乗り。これが違えば中身を見るまでもなく失敗。
    expect(new TextDecoder().decode(bytes.subarray(0, 12))).toBe('ISO-10303-21');
    console.log(`[実測] (a) STEP のバイト数: ${String(bytes.byteLength)}`);

    await importFile(page, stepPath);
    await openSolidSection(page);
    await expect(solidRows(page)).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
    await waitForRecompute(page);

    // 読み込んだほう(2 つ目)の体積が、元の箱と 1 文字も違わない。
    await solidRows(page).nth(1).click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });
    await expect(exactPropertyValue(page, '形式')).toHaveText('STEP');
    await expect(exactPropertyValue(page, '単位')).toHaveText('mm');

    // 元の箱も変わっていない(読み込みが今の文書を壊していない。NFR-RE-1)。
    await solidRows(page).first().click();
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`);

    expect(errors).toEqual([]);
  });

  test('(b) 箱を STL(バイナリ)で書き出して読み込むと、三角形 12 枚・体積 8000 になる(FR-803、FR-802)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await placeBox(page);

    // 「文字で書く(ASCII)」は既定が切(DEFAULT_EXPORT_ASCII = false)なので、触らなければバイナリ。
    await chooseFileMenu(page, '書き出す');
    const panel = exchangePanel(page);
    await expect(panel).toBeVisible();
    await panel.getByRole('radio', { name: 'STL', exact: true }).click();
    // STL には色の欄が無いので、その断りが 1 行出る(タスク32 の検証表、§0.15)。
    await expect(panel).toContainText('STL には色が付きません。');
await expect(panel.getByRole('checkbox')).not.toBeChecked();
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '書き出す', exact: true }).click();
    const stlPath = testInfo.outputPath('exchange-b.stl');
    await (await download).saveAs(stlPath);
    await expect(panel).toHaveCount(0);

    /*
      バイナリの STL は「80 バイトの見出し + 三角形の数(4 バイト)+ 三角形 1 枚 50 バイト」。
      12 枚なら 84 + 600 = 684 バイトちょうどで、文字で書いた STL とは桁が違う。
      ここで確かめておくと、次の読み込みが失敗したときに「書いた側か読んだ側か」が分かる。
    */
    const bytes = new Uint8Array(readFileSync(stlPath));
    expect(bytes.byteLength).toBe(84 + 12 * 50);
    console.log(`[実測] (b) STL のバイト数: ${String(bytes.byteLength)}`);

    await importFile(page, stlPath);
    // STL は単位を持たない形式なので、読む前に単位を訊かれる(§0.a-0.6)。
    await answerMillimetre(page);
    await openSolidSection(page);
    await expect(solidRows(page)).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
    await waitForRecompute(page);

    await solidRows(page).nth(1).click();
    await expect(sectionPropertyValue(page, '対象', '三角形の数')).toHaveText('12', {
      timeout: KERNEL_TIMEOUT_MS,
    });
    await expect(sectionPropertyValue(page, '対象', '体積')).toHaveText(String(BOX_VOLUME));
    await expect(exactPropertyValue(page, '形式')).toHaveText('STL');
    await expect(exactPropertyValue(page, '単位')).toHaveText('mm');

    expect(errors).toEqual([]);
  });

  test('(c) inch の STEP を読み込むと、寸法が 25.4 倍で入る(FR-811)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await placeBox(page);

    // mm で書き出したものを、座標はそのままに「単位だけ inch」へ書き換える。
    const millimetrePath = testInfo.outputPath('exchange-c-mm.step');
    const inchPath = testInfo.outputPath('exchange-c-inch.step');
    const millimetreBytes = await exportShape(page, 'STEP', millimetrePath);
    const inchBytes = toInchStep(millimetreBytes);
    expect(new TextDecoder().decode(inchBytes)).toContain("CONVERSION_BASED_UNIT('INCH'");
    writeFileSync(inchPath, inchBytes);

    await importFile(page, inchPath);
    await openSolidSection(page);
    await expect(solidRows(page)).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
    await waitForRecompute(page);

    await solidRows(page).nth(1).click();
    // 素性の欄が「inch のファイルだった」と言う(FR-811)。
    await expect(exactPropertyValue(page, '単位')).toHaveText('inch', {
      timeout: KERNEL_TIMEOUT_MS,
    });
    /*
      1 辺は 20 → 20 inch = 508mm なので、体積は 25.4³ = 16387.064 倍になる。
      12 桁の表示に丸めが乗るため、相対 1e-9(倍精度の丸め 2 桁ぶんの余裕)で比べる。
    */
    const expected = BOX_VOLUME * MM_PER_INCH ** 3;
    await expectVolumeNear(page, expected, 1e-9);
    console.log(`[実測] (c) inch の STEP の体積: ${String(await volumeNumber(page))} mm³`);

    expect(errors).toEqual([]);
  });

  test('(d) 線と円弧の DXF を読み込むと、スケッチに線分と円弧ができて押し出せる(FR-813)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    const dxfPath = testInfo.outputPath('exchange-d.dxf');
    writeFileSync(dxfPath, halfDiscDxf(), 'utf8');

    await importFile(page, dxfPath);

    // 1) スケッチに線分と円弧が 1 つずつできる(立体ではなく図形として入る)。
    await expect(treeRow(page, '線分1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await expect(treeRow(page, '円弧1')).toBeVisible();

    // 2) その 2 つで面を張って 10 押し出す。
    await treeRow(page, '線分1').click();
    await treeRow(page, '円弧1').click({ modifiers: ['Shift'] });
    await sketchTool(page, '面').click();
    await page.locator('canvas.pcad-viewport__canvas').press('Enter');
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });

    await treeRow(page, '面1').click();
    await openToolMenu(page, '作る');
    await menuTool(page, '作る', '押し出し').click();
    await expect(popoverTitle(page)).toHaveText('押し出す');
    await fillFields(page, ['10']);
    await commitPopover(page);
    await expect(popover(page)).toHaveCount(0);

    // 3) 半円(π r² / 2)を 10 押し出した体積になる。
    await treeRow(page, '押し出し1').click();
    await waitForRecompute(page);
    const expected = ((Math.PI * DXF_RADIUS_MM ** 2) / 2) * 10;
    await expectVolumeNear(page, expected, 1e-9);
    console.log(
      `[実測] (d) DXF から押し出した体積: ${String(await volumeNumber(page))} mm³(厳密 ${String(expected)})`,
    );

    expect(errors).toEqual([]);
  });
});
