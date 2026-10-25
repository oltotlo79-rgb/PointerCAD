/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, writeAssemblyDocument } from '../../packages/io/src/index.js';
import {
  findHexNut, type AssemblyComponent, type AssemblyDocument, type AssemblyDocumentBundle, type BoltedJointRecord,
  type BoltedJointUserChoices, type FastenerDimensionSeries,
} from '../../packages/model/src/index.js';
import { chooseToolMenuItem, readAssemblyStats, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { holedPlateAssembly } from './boltedJointFlow.js';
import {
  boltedJointDialog, componentRows, expectVectorClose, fastenedBadges, openAndPickFourFaces, PLATE, READY_STATUS,
  resolvedPoses, selectComponent, statusBar, statusText,
} from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * ボルト締結(追加要件6)の受入の画面検査(EX-06.PERSIST・UNDO・UI)。組立は boltedJointFlow.ts と同じ実操作の
 * 穴付きの板 2 枚(40×30×10、(20,15) に φ9 の通し穴、1 つ目は原点で固定、2 つ目は y=-50)。
 *
 * 照合の別経路: 製品の「保存」で書いたファイルを Node で製品の読取り(io の readDocumentBundle)から開き、
 * 記録・台本・組を読む。文書が「変わらない」は、読んだ文書を savedAt を固定して書き出した全バイトの一致で確かめる
 * (保存の封筒の時刻だけを除いた、利用者が保存するファイルの中身そのもの)。配置は検査の口 pcadAssemblyStats の
 * 解いた値で読む。ナットの高さは model の寸法表(findHexNut)から読む。
 *
 * 手で求めた値(boltedJointFlow.ts と同じ組立):
 *   本体規格 M8: 締め付け 10 + 10 = 20、ナット m 6.8、推奨呼び長さ 40, 45, …、b 22(首下 L - 22 <= 20 なので 40 だけ)。
 *     提案 M8×40・ナット M8・外へ出る長さ 40 - 20 - 6.8 = 13.2。
 *   附属書JA M8(直す): ナット m 6.5、全径共通の一覧 …, 25, 30, …(未確認)。L >= 26.5 -> 30(首下 8 <= 20)。
 *     提案 M8×30・外へ出る長さ 30 - 20 - 6.5 = 3.5。
 *   M10 は φ9 の穴より太いので断る。
 *   部品の id: 板 component-1・component-2、締結でボルト component-3・ナット component-4、直すと新しいボルト
 *   component-5・ナット component-6(古い id を使い回さない)。記録の id は bolted-joint-1 のまま。
 */

const SAVED_AT = '2026-10-24T00:00:00.000Z';
const EDIT_TITLE = 'ボルトの締結を直す';

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
  readonly bundle: AssemblyDocumentBundle;
  /** savedAt を固定して書き出した文書の全バイト。 */
  readonly bytes: string;
}

/** 製品の「名前を付けて保存」で書いたファイルを、製品の読取りで別に開く。 */
async function saveAndRead(page: Page, info: TestInfo, step: string, app?: ElectronApplication): Promise<SavedAssembly> {
  const path = info.outputPath(`bolted-joint-accept-${step}.pcada`);
  await saveFlowFile(page, path, app);
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error(`${step}: 保存した組立を読めませんでした。`);
  return { document: read.bundle.document, bundle: read.bundle, bytes: writeAssemblyDocument(read.bundle.document, { savedAt: SAVED_AT }) };
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

function editDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: EDIT_TITLE, exact: true });
}

interface Proposal {
  readonly nominal: string;
  readonly length: number;
  readonly nut: string | null;
  readonly grip: number;
  readonly protrusion: number | null;
}

/** 窓の提案の欄を読む(画面に出た文をそのまま分ける)。 */
async function readProposal(dialog: Locator): Promise<Proposal> {
  const plan = dialog.getByTestId('bolted-joint-plan');
  await expect(plan).toBeVisible();
  const bolt = /^ボルト (M\d+) 呼び長さ\(mm\) ([\d.]+)$/u.exec(await dialog.getByTestId('bolted-joint-bolt').innerText());
  const nut = /^ナット (M\d+)$/u.exec(await dialog.getByTestId('bolted-joint-nut').innerText());
  const grip = /^締め付ける厚さ\(mm\) ([\d.]+)$/u.exec(await plan.getByText(/^締め付ける厚さ\(mm\) /u).innerText());
  const protrusionLine = plan.getByText(/^外へ出る長さ\(mm\) /u);
  const shown = (await protrusionLine.count()) > 0;
  const protrusion = shown ? /^外へ出る長さ\(mm\) ([\d.]+)$/u.exec(await protrusionLine.innerText()) : null;
  if (bolt === null || grip === null || (shown && protrusion === null)) {
    throw new Error(`提案の欄を読めませんでした: ${await plan.innerText()}`);
  }
  return { nominal: bolt[1] ?? '', length: Number(bolt[2]), nut: nut?.[1] ?? null, grip: Number(grip[1]),
    protrusion: protrusion === null ? null : Number(protrusion[1]) };
}

function standardPart(document: AssemblyDocument, catalog: 'hexBolt' | 'hexNut'): AssemblyComponent {
  const found = document.components.filter((component) => component.source.kind === 'standardPart'
    && component.source.catalog === catalog);
  expect(found, `${catalog} の部品の数`).toHaveLength(1);
  const [component] = found;
  if (component === undefined) throw new Error(`${catalog} がありません。`);
  return component;
}

/**
 * 画面の提案(呼び・長さ・ナット・締め付ける厚さ・外へ出る長さ)が、確定して保存した実モデルの値と一致する。
 * 呼びと長さは保存したボルトの台本、ナットは保存したナットの台本、締め付ける厚さは解いた配置でのボルトの首下から
 * ナットの座面までの距離、外へ出る長さは 呼び長さ − 締め付ける厚さ − model の寸法表のナットの高さ。
 */
async function expectProposalIsTheModel(page: Page, proposal: Proposal, saved: AssemblyDocument,
  series: FastenerDimensionSeries): Promise<void> {
  const bolt = standardPart(saved, 'hexBolt');
  const nut = standardPart(saved, 'hexNut');
  if (bolt.source.kind !== 'standardPart' || nut.source.kind !== 'standardPart') throw new Error('規格部品の出どころがありません。');
  expect([bolt.source.size, Number(bolt.source.options.length), bolt.source.options.dimensionSeries])
    .toEqual([proposal.nominal, proposal.length, series]);
  expect([nut.source.size, nut.source.options.dimensionSeries]).toEqual([proposal.nut, series]);
  const stats = await readAssemblyStats(page);
  const at = (id: string): readonly number[] => stats.components.find((component) => component.id === id)?.resolved?.position ?? [];
  const head = at(bolt.id), seat = at(nut.id);
  expect(head).toHaveLength(3);
  expect(seat).toHaveLength(3);
  expect(Math.hypot((seat[0] ?? NaN) - (head[0] ?? NaN), (seat[1] ?? NaN) - (head[1] ?? NaN), (seat[2] ?? NaN) - (head[2] ?? NaN)))
    .toBeCloseTo(proposal.grip, 6);
  const nutHeight = findHexNut(nut.source.size, series)?.mMax ?? Number.NaN;
  expect(proposal.protrusion).not.toBeNull();
  expect(proposal.protrusion ?? Number.NaN).toBeCloseTo(proposal.length - proposal.grip - nutHeight, 3);
}

/**
 * 保存した締結の記録: 2 つの板の id、選んだ穴の壁と合わせ面の参照(同じボディの面)、その穴が保存した部品の実際の
 * φ9 の穴の履歴であること、利用者の指定、足した部品の id。
 */
function expectRecord(saved: SavedAssembly, choices: BoltedJointUserChoices, componentIds: readonly string[]): BoltedJointRecord {
  const records = saved.document.boltedJoints ?? [];
  expect(records).toHaveLength(1);
  const [record] = records;
  if (record === undefined) throw new Error('締結の記録がありません。');
  expect(record.id).toBe('bolted-joint-1');
  expect([record.first.componentId, record.second.componentId]).toEqual(['component-1', 'component-2']);
  for (const pick of [record.first, record.second]) {
    const plate = saved.document.components.find((component) => component.id === pick.componentId);
    const partRef = plate?.source.kind === 'part' ? plate.source.partRef : '';
    const hole = saved.bundle.embeddedDocuments.get(partRef)?.document.solids.find((solid) => solid.id === pick.holeFeatureId);
    expect(hole?.kind === 'hole' ? [hole.diameter.value, hole.depth.kind] : hole?.kind).toEqual([PLATE.holeDiameter, 'through']);
    expect(pick.holeFace.bodyFeatureId).toBe(pick.matingFace.bodyFeatureId);
    expect([pick.holeFace.fingerprint.kind, pick.matingFace.fingerprint.kind]).toEqual(['face', 'face']);
  }
  expect(record.choices).toEqual(choices);
  expect(record.componentIds).toEqual(componentIds);
  const group = saved.document.components[0]?.rigidGroupId;
  expect(group).toBeDefined();
  expect(saved.document.components.map((component) => component.rigidGroupId)).toEqual(saved.document.components.map(() => group));
  return record;
}

const NEW_JOINT_CHOICES: BoltedJointUserChoices = { dimensionSeries: 'main', minimumProtrusion: 0, headWashers: [], nutWashers: [] };

/** 窓を開いて 4 面を選び、手で求めた本体規格の提案(M8×40)を確かめて「締結する」を押す。 */
async function fastenWithProposal(page: Page): Promise<Proposal> {
  await openAndPickFourFaces(page);
  await expect(statusText(page)).toHaveText(READY_STATUS);
  const proposal = await readProposal(boltedJointDialog(page));
  expect(proposal).toEqual({ nominal: 'M8', length: 40, nut: 'M8', grip: 20, protrusion: 13.2 });
  const token = await beginRecompute(page);
  await boltedJointDialog(page).getByTestId('bolted-joint-commit').click();
  await expect(boltedJointDialog(page)).toHaveCount(0);
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(4);
  await expect(fastenedBadges(page)).toHaveCount(4);
  return proposal;
}

/** 締結したボルト(部品の木の 3 行目)を選び、「ボルトで締結」で直す窓を開く。 */
async function openEditOnBolt(page: Page): Promise<Locator> {
  await selectComponent(page, 2);
  await chooseToolMenuItem(page, '組む', 'ボルトで締結');
  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('bolted-joint-prompt'))
    .toHaveText('記録した指定を欄に入れました。呼び・座金・長さの欄を直して「締結する」で入れ替えます。Esc でやめます。');
  return dialog;
}

/** 部品の木の行の「⋮」から「削除する」(assembly.spec.ts の chooseTreeComponentAction と同じ操作)。 */
async function deleteComponentRow(page: Page, index: number): Promise<void> {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: '部品' }),
  });
  await section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row').locator('.pcad-tree__more').nth(index).click();
  const item = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '削除する', exact: true });
  await expect(item).toBeVisible();
  const token = await beginRecompute(page);
  await item.click();
  await waitForRecompute(page, token);
}

export function registerBoltedJointAcceptTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('ボルト締結の受入(EX-06 保存・Undo・画面)', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

    test('締結する: 断った提案と取消は保存した文書を 1 バイトも変えず、提案の値は保存した実モデルの値と一致し、1 回の Undo/Redo と開き直しで全バイトと id を保つ', async ({ page }, info) => {
      const seen = watch(page);
      const app = appForPage(page);
      await holedPlateAssembly(page, info, app);
      // 部品を置き終えたので、検査の部品ファイルの口を外し、製品の保存の口で書く。
      await resetAssemblyFileGateway(page);
      const opened = await saveAndRead(page, info, 'opened', app);
      expect(ids(opened.document)).toEqual(['component-1', 'component-2']);

      // 1) 不適合(M10 は φ9 の穴より太い)は理由を出し、欄の Enter でも締結しない。Esc でやめても文書は 1 バイトも同じ。
      await openAndPickFourFaces(page);
      await boltedJointDialog(page).getByTestId('bolted-joint-nominal').selectOption('M10');
      await expect(boltedJointDialog(page).getByTestId('bolted-joint-reasons')).toContainText('穴がボルトの径より大きくありません。');
      await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/u);
      await expect(boltedJointDialog(page).getByTestId('bolted-joint-commit')).toBeDisabled();
      await boltedJointDialog(page).getByTestId('bolted-joint-protrusion').press('Enter');
      await expect(boltedJointDialog(page)).toBeVisible();
      await expect(componentRows(page)).toHaveCount(2);
      await boltedJointDialog(page).getByTestId('bolted-joint-protrusion').press('Escape');
      await expect(boltedJointDialog(page)).toHaveCount(0);
      expect((await saveAndRead(page, info, 'refused', app)).bytes).toBe(opened.bytes);

      // 2) 4 面を選んだ提案の値を読み、「締結する」で確定する。保存したファイルの実モデルの値と一致する。
      const proposal = await fastenWithProposal(page);
      const fastened = await saveAndRead(page, info, 'fastened', app);
      expect(ids(fastened.document)).toEqual(['component-1', 'component-2', 'component-3', 'component-4']);
      await expectProposalIsTheModel(page, proposal, fastened.document, 'main');
      expectRecord(fastened, NEW_JOINT_CHOICES, ['component-3', 'component-4']);
      expect(await shownIds(page)).toEqual(ids(fastened.document));
      const fastenedPoses = await resolvedPoses(page);

      // 3) 1 回の元に戻すで締結の前の全バイト、やり直すで締結の全バイトと同じ id に戻る。
      await clickHistory(page, '元に戻す');
      await expect(componentRows(page)).toHaveCount(2);
      expect((await saveAndRead(page, info, 'undone', app)).bytes).toBe(opened.bytes);
      await clickHistory(page, 'やり直す');
      await expect(fastenedBadges(page)).toHaveCount(4);
      expect((await saveAndRead(page, info, 'redone', app)).bytes).toBe(fastened.bytes);
      expect(await shownIds(page)).toEqual(ids(fastened.document));

      // 4) 保存したファイルを開き直すと、同じ id・配置・印で、もう一度保存しても全バイトが同じ。
      await openSaveFlowFile(page, info.outputPath('bolted-joint-accept-fastened.pcada'), app);
      await expect(componentRows(page)).toHaveCount(4);
      await expect(fastenedBadges(page)).toHaveCount(4);
      expect(await shownIds(page)).toEqual(ids(fastened.document));
      const reopened = await resolvedPoses(page);
      reopened.forEach((pose, index) => {
        expectVectorClose(pose.position, fastenedPoses[index]?.position ?? []);
        expectVectorClose(pose.rotation, fastenedPoses[index]?.rotation ?? []);
      });
      expect((await saveAndRead(page, info, 'reopened', app)).bytes).toBe(fastened.bytes);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });

    test('直す・削除・取消: 記録した入力で直す窓を開き、直した提案の値は保存した実モデルの値と一致し、取消は全バイトを保ち、直すと削除は 1 回の Undo で全バイトへ戻る', async ({ page }, info) => {
      const seen = watch(page);
      const app = appForPage(page);
      await holedPlateAssembly(page, info, app);
      await resetAssemblyFileGateway(page);
      await fastenWithProposal(page);
      const fastened = await saveAndRead(page, info, 'fastened', app);
      const record = expectRecord(fastened, NEW_JOINT_CHOICES, ['component-3', 'component-4']);

      // 1) ボルトを選んで開くと、保存した記録の指定が欄に入り、同じ入力から同じ M8×40 を提案する。
      let dialog = await openEditOnBolt(page);
      await expect(dialog.locator('select').first()).toHaveValue(record.choices.dimensionSeries);
      await expect(dialog.getByTestId('bolted-joint-nominal')).toHaveValue(record.choices.explicitBolt?.nominal ?? '');
      await expect(dialog.getByTestId('bolted-joint-protrusion')).toHaveValue(String(record.choices.minimumProtrusion ?? ''));
      await expect(dialog.getByTestId('bolted-joint-engagement')).toHaveValue(String(record.choices.engagement ?? ''));
      await expect(dialog.getByTestId('bolted-joint-bottom')).toHaveValue(String(record.choices.blindBottomClearance ?? ''));
      expect(await readProposal(dialog)).toEqual({ nominal: 'M8', length: 40, nut: 'M8', grip: 20, protrusion: 13.2 });

      // 2) 欄を変えてから「やめる」で閉じても、文書は 1 バイトも同じ。
      await dialog.locator('select').first().selectOption('annexJA');
      await expect(dialog.getByTestId('bolted-joint-bolt')).toHaveText('ボルト M8 呼び長さ(mm) 30');
      await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect((await saveAndRead(page, info, 'edit-cancelled', app)).bytes).toBe(fastened.bytes);

      // 3) 寸法系列を附属書JA に直すと、導出したボルトが M8×30 に変わる。確定して保存した実モデルの値と一致する。
      dialog = await openEditOnBolt(page);
      await dialog.locator('select').first().selectOption('annexJA');
      await expect(statusText(page)).toHaveText(READY_STATUS);
      const edited = await readProposal(dialog);
      expect(edited).toEqual({ nominal: 'M8', length: 30, nut: 'M8', grip: 20, protrusion: 3.5 });
      await expect(dialog.getByTestId('bolted-joint-fact')).toContainText(['この呼び長さが、この径の規格品として用意されているかは確認できていません。']);
      const token = await beginRecompute(page);
      await dialog.getByTestId('bolted-joint-commit').click();
      await expect(dialog).toHaveCount(0);
      await waitForRecompute(page, token);
      await expect(fastenedBadges(page)).toHaveCount(4);
      const editedSaved = await saveAndRead(page, info, 'edited', app);
      expect(ids(editedSaved.document)).toEqual(['component-1', 'component-2', 'component-5', 'component-6']);
      await expectProposalIsTheModel(page, edited, editedSaved.document, 'annexJA');
      const editedRecord = expectRecord(editedSaved, { ...NEW_JOINT_CHOICES, dimensionSeries: 'annexJA' }, ['component-5', 'component-6']);
      // 穴と合わせ面の選び方(参照)は直しても変わらない。
      expect([editedRecord.first, editedRecord.second]).toEqual([record.first, record.second]);

      // 4) 1 回の元に戻すで直す前の全バイト(古いボルト・ナットの id)、やり直すで直した全バイト(新しい id)。
      await clickHistory(page, '元に戻す');
      expect(await shownIds(page)).toEqual(ids(fastened.document));
      expect((await saveAndRead(page, info, 'edit-undone', app)).bytes).toBe(fastened.bytes);
      await clickHistory(page, 'やり直す');
      expect(await shownIds(page)).toEqual(ids(editedSaved.document));
      expect((await saveAndRead(page, info, 'edit-redone', app)).bytes).toBe(editedSaved.bytes);

      // 5) 新しいボルトを木の「削除する」で消すと、締結の記録も一緒に消える(直せなくなる)。板とナットの組は残る。
      //    1 回の元に戻すで直した後の全バイトへ戻る。
      await selectComponent(page, 2);
      await deleteComponentRow(page, 2);
      await expect(componentRows(page)).toHaveCount(3);
      const deleted = await saveAndRead(page, info, 'deleted', app);
      expect(ids(deleted.document)).toEqual(['component-1', 'component-2', 'component-6']);
      expect(deleted.document.boltedJoints ?? []).toEqual([]);
      await expect(fastenedBadges(page)).toHaveCount(3);
      await clickHistory(page, '元に戻す');
      await expect(componentRows(page)).toHaveCount(4);
      expect((await saveAndRead(page, info, 'delete-undone', app)).bytes).toBe(editedSaved.bytes);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });
  });
}
