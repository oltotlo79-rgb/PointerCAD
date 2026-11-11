import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { readDocumentBundle, readPcadFile, writeDocumentBundle, writePcadFile } from '../../packages/io/src/index.js';
import {
  addComponent, appendReference, appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor,
  createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY, type ContextReferenceLink, type Placement, type PrimitiveFeature,
  type ReferencePointFeature,
} from '../../packages/model/src/index.js';
import type { SubShapeRef } from '../../packages/model/src/index.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { contextReferenceCycleFlow } from './contextReferenceCycleFlow.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';

/*
 * 保存した組立の文脈の参照が部品の単位で循環していたら、開く時に断り、いま開いている文書・取り消しの履歴・形は
 * そのまま残る(candidate-21 の開く時の拒否を、利用者の画面まで通して確かめる)。
 *  1) 部品 A(板と基準点 P)と部品 B(球)を置いた組立を、製品の「開く」で開く(対照: 同じ口で正しい文書が開ける)。
 *  2) 「組立の中の参照」で A の P を B の面に結ぶ(1 段の Undo)。製品の「保存」でバイトを得る。
 *  3) 保存したバイトの結び付けだけに、逆向き(B の基準点を A の面から決める)を 1 本足す。形・部品・配置は変えない。
 *  4) 意図して壊したそのバイトは、製品の厳密な読み手(readDocumentBundle)も結び付けの欄の誤りとして断る(検査の外で読めると
 *     期待しない)。それを「開く」と赤い帯に理由が出て、組立・配置・結び付け・Undo の履歴は 2) のまま。元に戻す 1 回で結び付けが消える。
 *  5) 対照: 2) で保存した循環の無いバイトは、同じ口で開けて結び付けが 1 本ある。
 * 部品と組立の作り方・検査用のファイル口は context-reference-route5.spec.ts と同じ(spec は import できないので写した)。
 */

const SAVED_AT = '2026-10-16T00:00:00.000Z';
const P_ID = 'refpoint-1';
const CORRUPTED = 'ファイルが壊れているため開けませんでした。';
const value = (n: number) => expressionValueFromNumber(n);

declare global {
  interface Window {
    cycleOpenSaved?: number[];
    cycleOpenFile?: { readonly name: string; readonly bytes: number[] } | null;
  }
}

function placement(x: number, y: number, z: number): Placement {
  return { position: [value(x), value(y), value(z)], rotation: [0, 0, 0, 1] };
}

/** 部品 A: 板(中心 (20,15,5))と基準点 P (10,15,0)。 */
function bracketPartFile(): Uint8Array {
  const plate: PrimitiveFeature = { id: 'box-1', name: '板', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(20), y: value(15), z: value(5) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: value(40), sizeY: value(30), sizeZ: value(10) } };
  const point: ReferencePointFeature = { id: P_ID, name: 'P', visible: true, kind: 'referencePoint',
    definition: { kind: 'coordinate', at: { mode: 'absolute', x: value(10), y: value(15), z: value(0) } } };
  return writePcadFile(appendSolid(appendReference({ ...createEmptyPartDocument(), name: '板A' }, point), plate), { savedAt: SAVED_AT });
}

/** 部品 B: 球(中心 (0,0,0)、半径 2)。面は 1 枚。 */
function spherePart() {
  const sphere: PrimitiveFeature = { id: 'sphere-1', name: '球', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(0), y: value(0), z: value(0) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'sphere', radius: value(2) } };
  return appendSolid({ ...createEmptyPartDocument(), name: '球B' }, sphere);
}

async function assemblyFile(): Promise<Uint8Array> {
  const read = readPcadFile(bracketPartFile());
  if (!read.ok) throw new Error(read.error.message);
  const a = await embedPart(EMPTY_PART_LIBRARY, read.document, '板A.pcad', '', { importedAt: SAVED_AT });
  const s = await embedPart(a.library, spherePart(), '球B.pcad', '', { importedAt: SAVED_AT });
  let document = createAssemblyDocument('循環の拒否');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: a.partRef },
    { partName: '板A', placement: placement(0, 0, 0) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: s.partRef },
    { partName: '球B', placement: placement(10, 15, 10) }));
  return writeDocumentBundle(createAssemblyDocumentBundle(document, s.library), { savedAt: SAVED_AT });
}

/** 保存した組立の結び付け。 */
async function savedLinks(saved: Uint8Array): Promise<readonly ContextReferenceLink[]> {
  const read = await readDocumentBundle(saved, 'assembly');
  // 断られた時は、製品の読み手が返した理由(code と文言)をそのまま失敗に載せる(次の切り分けのため)。
  if (!read.ok) throw new Error(`保存した組立を読めません(${read.error.code}: ${read.error.message})。`);
  if (read.bundle.kind !== 'assembly') throw new Error(`保存したものが組立ではありません(${read.bundle.kind})。`);
  return read.bundle.document.contextReferences ?? [];
}

/**
 * 保存したバイトの結び付けだけに、逆向きを 1 本足す(先と元を入れ替え、B の基準点の id を別にする)。
 * 今までの開く時の確かめ(id・先の重複、欠けた元、部品でない先、元と先が同じ配置)は全て通る形で、部品の単位で循環する。
 * 書いたバイトは製品の読み手では読めない(循環で断る)ので、書き込んだ結び付けを一緒に返して形を確かめる。
 */
async function withReverseLink(saved: Uint8Array): Promise<{ readonly bytes: Uint8Array; readonly links: readonly ContextReferenceLink[] }> {
  const read = await readDocumentBundle(saved, 'assembly');
  if (!read.ok) throw new Error(`保存した組立を読めません(${read.error.code}: ${read.error.message})。`);
  if (read.bundle.kind !== 'assembly') throw new Error(`保存したものが組立ではありません(${read.bundle.kind})。`);
  const bundle = read.bundle;
  const [link] = bundle.document.contextReferences ?? [];
  if (link === undefined) throw new Error('結び付けがありません。');
  const reverse: ContextReferenceLink = { id: `${link.id}-reverse`, targetComponentId: link.sourceComponentId,
    targetReferenceId: `${P_ID}-reverse`, sourceComponentId: link.targetComponentId, source: link.source };
  const links = [link, reverse];
  return { bytes: await writeDocumentBundle({ ...bundle, document: { ...bundle.document, contextReferences: links } },
    { savedAt: SAVED_AT }), links };
}

/** 実物の検査用ファイル口(PointerCadApp.tsx の `pcadSetFileGateway`)。route5 の spec と同じ形。 */
async function installGateway(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.pcadSetFileGateway === 'function', undefined, { timeout: 15_000 });
  await page.evaluate(() => {
    const install = window.pcadSetFileGateway;
    if (install === undefined) throw new Error('検査専用の口 pcadSetFileGateway が見つかりません。');
    install({
      openPcad: () => {
        const file = window.cycleOpenFile ?? null;
        window.cycleOpenFile = null;
        return Promise.resolve(file === null ? null : { name: file.name, bytes: new Uint8Array(file.bytes), saveTargetToken: null });
      },
      savePcad: (name, saved) => { window.cycleOpenSaved = [...saved]; return Promise.resolve(name); },
      hasSaveTarget: () => false,
      confirmSaveTarget: () => Promise.resolve(),
      clearSaveTarget: () => undefined,
    });
  });
}

function fileAction(page: Page, name: string): Locator {
  return page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name, exact: true });
}

function statusBar(page: Page): Locator {
  return page.locator('.pcad-statusbar');
}

/** 開けるバイトを開く。`discard` は保存していない変更がある時の画面の中の確認に「保存せずに続ける」で答える。 */
async function openBytes(page: Page, name: string, bytes: Uint8Array, discard = false): Promise<void> {
  await page.evaluate((file) => { window.cycleOpenFile = file; }, { name, bytes: [...bytes] });
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (discard) {
    const confirm = page.getByRole('alertdialog', { name: '保存していない変更があります' });
    await confirm.getByRole('button', { name: '保存せずに続ける', exact: true }).click();
    await expect(confirm).toHaveCount(0);
  }
  await waitForRecompute(page, token);
  expect(await page.evaluate(() => window.cycleOpenFile ?? null)).toBeNull();
  await expect(statusBar(page)).not.toHaveClass(/pcad-statusbar--error/u);
}

/** 断られるバイトを開く。口がバイトを渡し終え、赤い帯に理由が出るまで待つ(作り直しは起きない)。 */
async function openRefused(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate((file) => { window.cycleOpenFile = file; }, { name, bytes: [...bytes] });
  await fileAction(page, '開く').click();
  await expect.poll(() => page.evaluate(() => window.cycleOpenFile ?? null)).toBeNull();
  await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/u);
  await expect(page.locator('.pcad-statusbar__text')).toHaveText(CORRUPTED);
}

async function saveBytes(page: Page): Promise<Uint8Array> {
  await page.evaluate(() => { delete window.cycleOpenSaved; });
  await fileAction(page, '保存').click();
  await expect.poll(() => page.evaluate(() => window.cycleOpenSaved?.length ?? 0)).toBeGreaterThan(0);
  return Uint8Array.from(await page.evaluate(() => window.cycleOpenSaved ?? []));
}

function contextForm(page: Page): Locator {
  return page.getByTestId('assembly-context-form');
}

async function selectComponent(page: Page, index: number): Promise<void> {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: '部品' }) });
  const row = section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row').locator('.pcad-tree__select').nth(index);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

function placementsOf(stats: Awaited<ReturnType<typeof readAssemblyStats>>): readonly unknown[] {
  return stats.components.map(component => [component.id, component.sourceRef, component.resolved]);
}

test.describe('組立の文脈の参照の循環を開く時に断る', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('循環する保存は理由を出して開かず、いまの組立・結び付け・Undo の履歴が残る。循環の無い保存は同じ口で開ける', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
      }
    });
    await page.goto('/');
    await installGateway(page);

    // 1) 対照: 正しい組立は製品の「開く」で開ける。
    await openBytes(page, '循環の拒否.pcada', await assemblyFile());
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');

    // 2) A の P を B のただ 1 つの面に結ぶ(route5 と同じ画面の操作。1 段の Undo)。保存したバイトに結び付けが 1 本。
    await selectComponent(page, 0);
    await expect(contextForm(page)).toBeVisible();
    await page.getByTestId('assembly-context-point').selectOption({ label: 'P' });
    await expect(page.getByTestId('assembly-context-face').locator('option')).toHaveCount(2);
    await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
    const token = await beginRecompute(page);
    await contextForm(page).getByRole('button', { name: '参照を作る', exact: true }).click();
    await waitForRecompute(page, token);
    await expect(contextForm(page).getByRole('alert')).toHaveCount(0);
    const valid = await saveBytes(page);
    const validLinks = await savedLinks(valid);
    expect(validLinks).toHaveLength(1);
    const before = placementsOf(await readAssemblyStats(page));

    // 3)・4) 逆向きを足した循環する保存は、理由を出して開かない。組立・配置・結び付けは 2) のまま。
    const [forward] = validLinks;
    if (forward === undefined) throw new Error('結び付けがありません。');
    expect(forward.targetComponentId).not.toBe(forward.sourceComponentId);
    const cyclic = await withReverseLink(valid);
    // 書き込んだのは 2) の結び付けと、その先と元を入れ替えた逆向き(B の基準点を A の面から決める)の 2 本だけ。
    expect(cyclic.links).toEqual([forward, { id: `${forward.id}-reverse`, targetComponentId: forward.sourceComponentId,
      targetReferenceId: `${P_ID}-reverse`, sourceComponentId: forward.targetComponentId, source: forward.source }]);
    // 意図して壊したバイトは、製品の厳密な読み手が結び付けの欄の誤り(invalidField)として断る。読めるとは期待しない。
    const strict = await readDocumentBundle(cyclic.bytes, 'assembly');
    expect(strict.ok ? 'read' : strict.error.code).toBe('invalidField');
    expect(strict.ok ? '' : strict.error.message).toContain('contextReferences');
    await openRefused(page, '循環.pcada', cyclic.bytes);
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    expect(placementsOf(await readAssemblyStats(page))).toEqual(before);
    expect(await savedLinks(await saveBytes(page))).toEqual(validLinks);

    // Undo の履歴も残る: 元に戻す 1 回で、2) で作った結び付けが消える。
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await waitForSettledRecompute(page);
    expect(await savedLinks(await saveBytes(page))).toEqual([]);

    // 5) 対照: 2) で保存した循環の無いバイトは、同じ口で開けて結び付けが 1 本ある。
    await openBytes(page, '循環の無い.pcada', valid);
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    expect(await savedLinks(await saveBytes(page))).toEqual(validLinks);
    expect(errors).toEqual([]);
  });
});

/*
 * EX-18 W09 の追加(既存の検査は変えない)。
 *  - 循環になる参照の追加と置き換え(修復)を、循環の理由の文を出して断る(手順は contextReferenceCycleFlow.ts。Electron は
 *    electron-context-reference-cycle.spec.ts が同じ手順を呼ぶ)。
 *  - 起動直後の空の文書で循環する保存を開くと、帯に知らせを出して組立を開かず、空の部品の文書のまま。
 *    循環を閉じる 2 本目だけを除いた同じ組立は、同じ口で開ける(対照)。
 */

/** 循環の読込みで、製品の読み手が返す理由(assemblyJson.ts の failField。結び付けの欄の誤り)。 */
const CYCLE_REFUSAL = ['invalidField', 'ファイルの中身が壊れています(document.contextReferences の形が違います)。'];

/** A の板の上面と、B の球の面(保存の形だけを満たす参照。開く時は形を計算しない)。 */
const PLATE_TOP: SubShapeRef = { bodyFeatureId: 'box-1', index: 5, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1200,
  position: [20, 15, 10], axis: [0, 0, 1], radius: null } };
const SPHERE_FACE: SubShapeRef = { bodyFeatureId: 'sphere-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'sphere',
  area: 16 * Math.PI, position: [0, 0, 0], axis: null, radius: 2 } };

function componentIdAt(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) throw new Error(`配置 ${String(index)} がありません。`);
  return id;
}

/** A の P を B の球の面から決める結び付け(循環しない 1 本)。 */
function forwardLink(ids: readonly string[]): ContextReferenceLink {
  return { id: 'context-1', targetComponentId: componentIdAt(ids, 0), targetReferenceId: P_ID,
    sourceComponentId: componentIdAt(ids, 1), source: SPHERE_FACE };
}

/** 保存したバイトの結び付けを、配置の id から作った一覧に替える(形・部品・配置は変えない。書き手は循環を確かめない)。 */
async function withLinks(saved: Uint8Array, build: (ids: readonly string[]) => readonly ContextReferenceLink[]): Promise<Uint8Array> {
  const read = await readDocumentBundle(saved, 'assembly');
  if (!read.ok) throw new Error(`保存した組立を読めません(${read.error.code}: ${read.error.message})。`);
  if (read.bundle.kind !== 'assembly') throw new Error(`保存したものが組立ではありません(${read.bundle.kind})。`);
  const bundle = read.bundle;
  const contextReferences = build(bundle.document.components.map(component => component.id));
  return writeDocumentBundle({ ...bundle, document: { ...bundle.document, contextReferences } }, { savedAt: SAVED_AT });
}

test.describe('EX-18 W09 組立の中の参照の循環を、足す時・置き換える時・起動直後に開く時に断る', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('循環になる参照の追加と置き換えは循環の理由を出して断り、保存した組立・部品と Undo の履歴が変わらない', async ({ page }) => {
    await contextReferenceCycleFlow(page, '/');
  });

  test('起動直後の空の文書で循環する保存を開くと、知らせを出して組立を開かず空の文書のまま。循環を閉じる 1 本を除くと開ける', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
      }
    });
    await page.goto('/');
    await installGateway(page);
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
    await expect(page.locator('.pcad-viewport__empty-state')).toBeVisible();

    // A の P を B から、B の基準点を A から決める 2 本は、部品の単位で循環する(先・id の重なり・欠けた配置は無い)。
    const plainAssembly = await assemblyFile();
    const cyclic = await withLinks(plainAssembly, ids => [forwardLink(ids), { id: 'context-2',
      targetComponentId: componentIdAt(ids, 1), targetReferenceId: `${P_ID}-reverse`, sourceComponentId: componentIdAt(ids, 0),
      source: PLATE_TOP }]);
    // 製品の厳密な読み手も、結び付けの欄の誤りとして断る(検査の外で読めるとは期待しない)。
    const strict = await readDocumentBundle(cyclic, 'assembly');
    expect(strict.ok ? 'read' : [strict.error.code, strict.error.message]).toEqual(CYCLE_REFUSAL);
    await openRefused(page, '循環.pcada', cyclic);
    // 組立は開かれず、起動直後の空の部品の文書のまま。
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'part');
    await expect(page.locator('.pcad-viewport__empty-state')).toBeVisible();

    // 対照: 循環を閉じる 2 本目を除いた同じ組立は、同じ口で開けて、保存すると同じ 1 本の結び付けがある。
    const acyclic = await withLinks(plainAssembly, ids => [forwardLink(ids)]);
    await openBytes(page, '循環の無い.pcada', acyclic);
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    expect(await savedLinks(await saveBytes(page))).toEqual(await savedLinks(acyclic));
    expect(errors).toEqual([]);
  });
});
