/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test as baseTest, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, writeAssemblyDocument } from '../../packages/io/src/index.js';
import {
  filletWeldLegs, filletWeldNominalVolume, filletWeldSegmentOptions, findDensityMaterial,
  type AssemblyComponent, type AssemblyDocument,
} from '../../packages/model/src/index.js';
import { chooseToolMenuItem, readAssemblyStats, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome, statusBar, statusText } from './boltedJointTestSupport.js';
import {
  blockAssembly, bomRows, EDIT_TITLE, expectReady, field, fillWeld, INPUT, openAndPick, PICK, TITLE, VOLUME_LABEL, weldDialog,
  type WeldInput,
} from './filletWeldFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * すみ肉溶接(追加要件8)の受入の画面検査(EX-08.PERSIST・UNDO・UI)。組立は filletWeldFlow.ts と同じ実操作の角材 2 つ
 * (底: 原点・固定 = component-1、立つ: (0,14,20) = component-2)と、同じ断続のビードの入力
 * (脚 6 / 8、始点 4、長さ 10・18.5・7.25、間隔 6・9.75、アルミ)。
 *
 * 照合の別経路: 製品の「保存」で書いたファイルを Node で製品の読取り(io の readDocumentBundle)から開き、ビードの台本
 * (脚長・始点・長さ・番号・溶接した 2 部品)と材質を読む。画面の予告の値(脚長・ビードの数・合計の長さ・体積)は、その
 * 保存した入力から model の関数(filletWeldLegs・filletWeldSegmentOptions・filletWeldNominalVolume)で求め直した値と
 * 比べる。部品表の質量(実カーネルの体積 × 密度)は、model の公称体積 × 材質の密度(findDensityMaterial)の小数 2 桁と
 * 比べる(実カーネルと model の独立な一致)。文書が「変わらない」は、読んだ文書を savedAt を固定して書き出した全バイトの
 * 一致で確かめる。
 *
 * 手で求めた値: 合計 35.75、体積 6 × 8 / 2 × 35.75 = 858。3 本目を 9 に直すと合計 37.5・体積 900。3 本目を 20 にすると
 * 48.25 + 20 = 68.25 > 60 で当たりの辺からはみ出す。部品の id はビードが component-3〜5、直すと新しい component-6〜8
 * (古い id を使い回さない)。溶接した 2 部品は 1 つ目の面を押した立つ角材(component-2)と底の角材(component-1)。
 */

const SAVED_AT = '2026-10-24T00:00:00.000Z';
const OVERRUN = 'すみ肉溶接: ビードが当たりの辺からはみ出します。始点か長さを短くしてください。';

interface Watch {
  readonly errors: string[];
  readonly dialogs: string[];
}

function watch(page: Page): Watch {
  const errors: string[] = [];
  const dialogs: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  return { errors, dialogs };
}

interface SavedAssembly {
  readonly document: AssemblyDocument;
  /** savedAt を固定して書き出した文書の全バイト。 */
  readonly bytes: string;
}

function savedPath(info: TestInfo, step: string): string {
  return info.outputPath(`fillet-weld-accept-${step}.pcada`);
}

/** 製品の「名前を付けて保存」で書いたファイルを、製品の読取りで別に開く。 */
async function saveAndRead(page: Page, info: TestInfo, step: string, app?: ElectronApplication): Promise<SavedAssembly> {
  const path = savedPath(info, step);
  await saveFlowFile(page, path, app);
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error(`${step}: 保存した組立を読めませんでした。`);
  return { document: read.bundle.document, bytes: writeAssemblyDocument(read.bundle.document, { savedAt: SAVED_AT }) };
}

function ids(document: AssemblyDocument): readonly string[] {
  return document.components.map((component) => component.id);
}

async function shownIds(page: Page): Promise<readonly string[]> {
  return (await readAssemblyStats(page)).components.map((component) => component.id);
}

async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const token = await beginRecompute(page);
  await page.getByRole('button', { name, exact: true }).click();
  await waitForRecompute(page, token);
}

interface SavedBead {
  readonly component: AssemblyComponent;
  readonly size: string;
  readonly lengthSource: string;
  readonly legs: { readonly legOnSecond: number; readonly legOnFirst: number };
  readonly segment: NonNullable<ReturnType<typeof filletWeldSegmentOptions>>;
}

/** 保存した文書のビード(文書の順)。台本の欄を model の読み方で読む。 */
function savedBeads(document: AssemblyDocument): readonly SavedBead[] {
  return document.components.flatMap((component) => {
    if (component.source.kind !== 'standardPart' || component.source.catalog !== 'filletWeld') return [];
    const legs = filletWeldLegs(component.source.size);
    const segment = filletWeldSegmentOptions(component.source.options);
    const lengthSource = component.source.options.length;
    if (legs === null || segment === null || lengthSource === undefined) throw new Error(`${component.id} の台本を読めませんでした。`);
    return [{ component, size: component.source.size, lengthSource, legs, segment }];
  });
}

interface WeldPlanShown {
  readonly legs: readonly [number, number];
  readonly count: number;
  readonly total: number;
  readonly volume: number;
}

/** 窓の予告の欄を読む(画面に出た文をそのまま分ける)。 */
async function readWeldPlan(page: Page, title = TITLE): Promise<WeldPlanShown> {
  const legs = /^脚長\(mm\) ([\d.]+) \/ ([\d.]+)$/u.exec(await field(page, 'fillet-weld-legs', title).innerText());
  const count = /^ビードの数 (\d+)$/u.exec(await field(page, 'fillet-weld-segments', title).innerText());
  const total = /^合計の長さ\(mm\) ([\d.]+)$/u.exec(await field(page, 'fillet-weld-total', title).innerText());
  const volumeText = await field(page, 'fillet-weld-volume', title).innerText();
  if (legs === null || count === null || total === null || !volumeText.startsWith(`${VOLUME_LABEL} `)) {
    throw new Error(`予告の欄を読めませんでした: ${await field(page, 'fillet-weld-plan', title).innerText()}`);
  }
  return { legs: [Number(legs[1]), Number(legs[2])], count: Number(count[1]), total: Number(total[1]),
    volume: Number(volumeText.slice(VOLUME_LABEL.length + 1)) };
}

/**
 * 画面の予告の値と入力が、確定して保存した実モデルの値と一致する: ビードの数・脚長・始点・長さ・間隔・材質・溶接した
 * 2 部品・溶接の id・組、合計の長さと公称体積(保存した入力から model の関数で求め直す)。
 */
function expectWeldIsTheModel(shown: WeldPlanShown, document: AssemblyDocument, input: WeldInput): void {
  const beads = savedBeads(document);
  expect(beads).toHaveLength(shown.count);
  const lengths = beads.map((bead) => bead.segment.length);
  const stations = beads.map((bead) => bead.segment.station);
  for (const bead of beads) {
    expect([bead.legs.legOnSecond, bead.legs.legOnFirst]).toEqual(shown.legs);
    expect([bead.legs.legOnSecond, bead.legs.legOnFirst]).toEqual([Number(input.legOnSecond), Number(input.legOnFirst)]);
    expect(bead.component.materialId).toBe(input.material);
    expect([bead.segment.weldId, bead.segment.parts]).toEqual(['weld-1', ['component-2', 'component-1']]);
  }
  expect(beads.map((bead) => bead.segment.segment)).toEqual(beads.map((_bead, index) => index));
  expect(stations[0]).toBe(Number(input.start));
  expect(beads.map((bead) => bead.lengthSource).join(', ')).toBe(input.lengths);
  expect(stations.slice(1).map((station, index) => station - ((stations[index] ?? Number.NaN) + (lengths[index] ?? Number.NaN))))
    .toEqual(input.gaps.split(',').map((gap) => Number(gap)));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  expect(total).toBeCloseTo(shown.total, 9);
  const volume = beads.reduce((sum, bead) => sum + filletWeldNominalVolume(bead.legs.legOnSecond, bead.legs.legOnFirst,
    bead.segment.length), 0);
  expect(volume).toBeCloseTo(shown.volume, 3);
  const group = document.components[0]?.rigidGroupId;
  expect(group).toBeDefined();
  expect(document.components.map((component) => component.rigidGroupId)).toEqual(document.components.map(() => group));
}

/** 部品表のビードの行の質量(実カーネルの体積 × 密度)が、model の公称体積 × 材質の密度の小数 2 桁と一致する。 */
async function expectBeadMassesAreTheModel(page: Page, document: AssemblyDocument): Promise<void> {
  await expect(page.locator('.pcad-bom__table')).toBeVisible();
  for (const bead of savedBeads(document)) {
    const density = findDensityMaterial(bead.component.materialId ?? '')?.density ?? Number.NaN;
    const grams = filletWeldNominalVolume(bead.legs.legOnSecond, bead.legs.legOnFirst, bead.segment.length) * density / 1000;
    const row = bomRows(page).filter({
      hasText: `すみ肉溶接 ${String(bead.legs.legOnSecond)}×${String(bead.legs.legOnFirst)} 長さ${bead.lengthSource}`,
    });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`${grams.toFixed(2)} g`);
  }
}

/** 直す窓の全ての欄が、保存した文書の入力(model の読み方で読んだ台本と材質)と一致する。 */
async function expectEditFieldsAreSaved(page: Page, document: AssemblyDocument): Promise<void> {
  const beads = savedBeads(document);
  const [first] = beads;
  if (first === undefined) throw new Error('保存した文書にビードがありません。');
  const stations = beads.map((bead) => bead.segment.station);
  const gaps = stations.slice(1).map((station, index) => station - ((stations[index] ?? Number.NaN)
    + (beads[index]?.segment.length ?? Number.NaN)));
  await expect(weldDialog(page, EDIT_TITLE)).toBeVisible();
  await expect(field(page, 'fillet-weld-leg-second', EDIT_TITLE)).toHaveValue(String(first.legs.legOnSecond));
  await expect(field(page, 'fillet-weld-leg-first', EDIT_TITLE)).toHaveValue(String(first.legs.legOnFirst));
  await expect(field(page, 'fillet-weld-mode', EDIT_TITLE)).toHaveValue(beads.length > 1 ? 'intermittent' : 'continuous');
  await expect(field(page, 'fillet-weld-start', EDIT_TITLE)).toHaveValue(String(first.segment.station));
  await expect(field(page, 'fillet-weld-lengths', EDIT_TITLE)).toHaveValue(beads.map((bead) => bead.lengthSource).join(', '));
  await expect(field(page, 'fillet-weld-gaps', EDIT_TITLE)).toHaveValue(gaps.map((gap) => String(gap)).join(', '));
  await expect(field(page, 'fillet-weld-material', EDIT_TITLE)).toHaveValue(first.component.materialId ?? '');
}

/** 2 本目のビードの斜面をビューで押して選び、溶接の道具で「直す」窓を開く(filletWeldFlow.ts と同じ操作)。 */
async function openEditOnSecondBead(page: Page): Promise<void> {
  await goHome(page);
  await clickWorldPointChecked(page, PICK.secondBeadSlope);
  await expect(componentRows(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
  await chooseToolMenuItem(page, '組む', TITLE);
  await expect(weldDialog(page, EDIT_TITLE)).toBeVisible();
}

/** 断る欄の値: 予告の代わりに理由(赤い状態欄)、「溶接する」は押せず、欄の Enter でも溶接せず、Esc でやめる。 */
async function expectOverrunRefused(page: Page, title: string): Promise<void> {
  await expect(statusText(page)).toHaveText(OVERRUN);
  await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/u);
  await expect(field(page, 'fillet-weld-commit', title)).toBeDisabled();
  await field(page, 'fillet-weld-lengths', title).press('Enter');
  await expect(weldDialog(page, title)).toBeVisible();
  await field(page, 'fillet-weld-lengths', title).press('Escape');
  await expect(weldDialog(page, title)).toHaveCount(0);
}

/** 窓の予告どおりに「溶接する」を押し、作り直しが終わるまで待つ。 */
async function commitWeld(page: Page, title: string): Promise<void> {
  const token = await beginRecompute(page);
  await field(page, 'fillet-weld-commit', title).click();
  await expect(weldDialog(page, title)).toHaveCount(0);
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(5);
}

export function registerFilletWeldAcceptTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('すみ肉溶接の受入(EX-08 保存・Undo・画面)', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

    test('溶接する・溶接を消す: 断った予告と取消は保存した文書を 1 バイトも変えず、予告の値は保存した実モデルと実カーネルの値に一致し、1 回の Undo/Redo で全バイトと id へ戻る', async ({ page }, info) => {
      const seen = watch(page);
      const app = appForPage(page);
      await blockAssembly(page, info, app);
      // 部品を置き終えたので、検査の部品ファイルの口を外し、製品の保存の口で書く。
      await resetAssemblyFileGateway(page);
      const opened = await saveAndRead(page, info, 'opened', app);
      expect(ids(opened.document)).toEqual(['component-1', 'component-2']);

      // 1) 3 本目が当たりの辺からはみ出す入力は断り、欄の Enter でも溶接しない。Esc でやめても文書は 1 バイトも同じ。
      await openAndPick(page);
      await fillWeld(page, { ...INPUT, lengths: '10, 18.5, 20' });
      await expectOverrunRefused(page, TITLE);
      await expect(componentRows(page)).toHaveCount(2);
      expect((await saveAndRead(page, info, 'refused', app)).bytes).toBe(opened.bytes);

      // 2) 予告の値を読み、「溶接する」で確定する。保存したファイルの実モデルの値と、部品表の実カーネルの質量に一致する。
      await openAndPick(page);
      await fillWeld(page, INPUT);
      await expectReady(page, '35.75', '858');
      const shown = await readWeldPlan(page);
      expect(shown).toEqual({ legs: [6, 8], count: 3, total: 35.75, volume: 858 });
      await commitWeld(page, TITLE);
      const welded = await saveAndRead(page, info, 'welded', app);
      expect(ids(welded.document)).toEqual(['component-1', 'component-2', 'component-3', 'component-4', 'component-5']);
      expectWeldIsTheModel(shown, welded.document, INPUT);
      await expectBeadMassesAreTheModel(page, welded.document);
      expect(await shownIds(page)).toEqual(ids(welded.document));

      // 3) 1 回の元に戻すで溶接の前の全バイト、やり直すで溶接の全バイトと同じ id に戻る。
      await clickHistory(page, '元に戻す');
      await expect(componentRows(page)).toHaveCount(2);
      expect((await saveAndRead(page, info, 'undone', app)).bytes).toBe(opened.bytes);
      await clickHistory(page, 'やり直す');
      await expect(componentRows(page)).toHaveCount(5);
      expect((await saveAndRead(page, info, 'redone', app)).bytes).toBe(welded.bytes);
      expect(await shownIds(page)).toEqual(ids(welded.document));

      // 4) ビードを選んで「溶接を消す」: ビードだけが消え、2 つの角材の組と配置は残る。1 回の元に戻すで溶接の全バイト。
      await openEditOnSecondBead(page);
      const token = await beginRecompute(page);
      await field(page, 'fillet-weld-remove', EDIT_TITLE).click();
      await expect(weldDialog(page, EDIT_TITLE)).toHaveCount(0);
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(2);
      const removed = await saveAndRead(page, info, 'removed', app);
      expect(ids(removed.document)).toEqual(['component-1', 'component-2']);
      expect(savedBeads(removed.document)).toEqual([]);
      expect(removed.document.components).toEqual(welded.document.components.slice(0, 2));
      await clickHistory(page, '元に戻す');
      await expect(componentRows(page)).toHaveCount(5);
      expect((await saveAndRead(page, info, 'remove-undone', app)).bytes).toBe(welded.bytes);
      expect(await shownIds(page)).toEqual(ids(welded.document));
      await clickHistory(page, 'やり直す');
      await expect(componentRows(page)).toHaveCount(2);
      expect((await saveAndRead(page, info, 'remove-redone', app)).bytes).toBe(removed.bytes);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });

    test('溶接を直す: 開き直したファイルで直す窓の全ての欄が保存した入力と一致し、やめる・断った直しは全バイトを保ち、直した予告の値は保存した実モデルの値に一致し、1 回の Undo/Redo で全バイトと id へ戻る', async ({ page }, info) => {
      const seen = watch(page);
      const app = appForPage(page);
      await blockAssembly(page, info, app);
      await resetAssemblyFileGateway(page);
      await openAndPick(page);
      await fillWeld(page, INPUT);
      await expectReady(page, '35.75', '858');
      await commitWeld(page, TITLE);
      const welded = await saveAndRead(page, info, 'welded', app);

      // 1) 保存したファイルを開き直すと同じ id で、もう一度保存しても全バイトが同じ。直す窓の全ての欄が保存した入力。
      await openSaveFlowFile(page, savedPath(info, 'welded'), app);
      await expect(componentRows(page)).toHaveCount(5);
      expect(await shownIds(page)).toEqual(ids(welded.document));
      expect((await saveAndRead(page, info, 'reopened', app)).bytes).toBe(welded.bytes);
      await openEditOnSecondBead(page);
      await expectEditFieldsAreSaved(page, welded.document);
      await expectReady(page, '35.75', '858', EDIT_TITLE);

      // 2) 欄を直してから「やめる」で閉じても、文書は 1 バイトも同じ。
      await field(page, 'fillet-weld-lengths', EDIT_TITLE).fill('10, 18.5, 9');
      await expectReady(page, '37.5', '900', EDIT_TITLE);
      await weldDialog(page, EDIT_TITLE).getByRole('button', { name: 'やめる', exact: true }).click();
      await expect(weldDialog(page, EDIT_TITLE)).toHaveCount(0);
      expect((await saveAndRead(page, info, 'edit-cancelled', app)).bytes).toBe(welded.bytes);

      // 3) はみ出す直しは断り、Enter でも直さない。Esc でやめても文書は 1 バイトも同じ。
      await openEditOnSecondBead(page);
      await field(page, 'fillet-weld-lengths', EDIT_TITLE).fill('10, 18.5, 20');
      await expectOverrunRefused(page, EDIT_TITLE);
      await expect(componentRows(page)).toHaveCount(5);
      expect((await saveAndRead(page, info, 'edit-refused', app)).bytes).toBe(welded.bytes);

      // 4) 3 本目を 9 に直して確定する。予告の値は保存した実モデルの値に一致し、ビードは古い id を使わない。
      await openEditOnSecondBead(page);
      await field(page, 'fillet-weld-lengths', EDIT_TITLE).fill('10, 18.5, 9');
      await expectReady(page, '37.5', '900', EDIT_TITLE);
      const shown = await readWeldPlan(page, EDIT_TITLE);
      expect(shown).toEqual({ legs: [6, 8], count: 3, total: 37.5, volume: 900 });
      await commitWeld(page, EDIT_TITLE);
      const edited = await saveAndRead(page, info, 'edited', app);
      expect(ids(edited.document)).toEqual(['component-1', 'component-2', 'component-6', 'component-7', 'component-8']);
      expectWeldIsTheModel(shown, edited.document, { ...INPUT, lengths: '10, 18.5, 9' });
      await expectBeadMassesAreTheModel(page, edited.document);

      // 5) 1 回の元に戻すで直す前の全バイトと id、やり直すで直した全バイトと id。
      await clickHistory(page, '元に戻す');
      expect(await shownIds(page)).toEqual(ids(welded.document));
      expect((await saveAndRead(page, info, 'edit-undone', app)).bytes).toBe(welded.bytes);
      await clickHistory(page, 'やり直す');
      expect(await shownIds(page)).toEqual(ids(edited.document));
      expect((await saveAndRead(page, info, 'edit-redone', app)).bytes).toBe(edited.bytes);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });
  });
}
