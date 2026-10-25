import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { readDocumentBundle, readPcadFile, writeDocumentBundle, writePcadFile } from '../../packages/io/src/index.js';
import {
  addComponent, appendReference, appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor,
  createEmptyPartDocument, createPrimitiveFeature, embedPart, EMPTY_PART_LIBRARY, type ContextReferenceLink, type PartDocument,
  type Placement, type PrimitiveFeature, type ReferencePointFeature,
} from '../../packages/model/src/index.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

/*
 * EX-18 の 5 つ目の作り方(組立の文脈の参照)の「参照の直し」を画面で通す(模型の検査
 * ex18BracketContextReattachKernel.test.ts と同じ筋。context-reference-route5.spec.ts は作る・更新するだけ)。
 *  1) 部品 A(板と基準点 P)と部品 B(球、半径 2、中心は B の原点)を置いた組立を、製品の「開く」で開く。
 *     「組立の中の参照」で P を B のただ 1 つの面に結ぶ。保存した P は B の位置 (10,15,10)。
 *  2) B の部品を、同じ配置のまま別の部品(既定の箱 20×20×20、立体の id は box-1)に替えた保存を作る。A の部品・配置・
 *     結び付けは 1) の保存のまま。結び付けの元の面は球(sphere-1)を指すので、もう今の形では選べない。
 *  3) それを開いて「参照から更新」を押すと、理由が出て何も変わらない(保存した P と結び付けは前のまま)。
 *  4) 箱の面を選び直して「参照を置き換える」を押すと、同じ結び付けの id のまま P が箱の面の中心になる。
 *     独立した期待: 箱は中心が B の原点で一辺 20 なので、面の中心は (10,15,10) から軸に沿って ±10 のどれか。
 *  5) 元に戻す 1 回で、直す前の P に戻る(直しは 1 段の Undo)。
 * 部品と組立の作り方・検査用のファイル口は context-reference-route5.spec.ts と同じ(spec は import できないので写した)。
 */

const SAVED_AT = '2026-10-16T00:00:00.000Z';
const P_ID = 'refpoint-1';
const B_AT = [10, 15, 10] as const;
const value = (n: number) => expressionValueFromNumber(n);

declare global {
  interface Window {
    repairSaved?: number[];
    repairOpen?: { readonly name: string; readonly bytes: number[] } | null;
  }
}

function placement(x: number, y: number, z: number): Placement {
  return { position: [value(x), value(y), value(z)], rotation: [0, 0, 0, 1] };
}

/** 部品 A: 板(中心 (20,15,5))と基準点 P (10,15,0)。 */
function bracketPart(): PartDocument {
  const plate: PrimitiveFeature = { id: 'box-1', name: '板', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(20), y: value(15), z: value(5) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: value(40), sizeY: value(30), sizeZ: value(10) } };
  const point: ReferencePointFeature = { id: P_ID, name: 'P', visible: true, kind: 'referencePoint',
    definition: { kind: 'coordinate', at: { mode: 'absolute', x: value(10), y: value(15), z: value(0) } } };
  return appendSolid(appendReference({ ...createEmptyPartDocument(), name: '板A' }, point), plate);
}

/** 部品 B: 球(中心 (0,0,0)、半径 2)。面は 1 枚で、面の中心は B の原点。 */
function spherePart(): PartDocument {
  const sphere: PrimitiveFeature = { id: 'sphere-1', name: '球', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(0), y: value(0), z: value(0) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'sphere', radius: value(2) } };
  return appendSolid({ ...createEmptyPartDocument(), name: '球B' }, sphere);
}

/** 部品 B を替えたもの: 既定の箱(中心が原点、一辺 20、id は box-1)。 */
function boxPart(): PartDocument {
  const empty = { ...createEmptyPartDocument(), name: '箱B' };
  return appendSolid(empty, createPrimitiveFeature(empty, 'box'));
}

/** A と B を置いた組立。配置の id は置いた順に決まるので、B を替えても A・B の id は同じ。 */
async function assemblyFile(a: PartDocument, b: PartDocument, links?: readonly ContextReferenceLink[]): Promise<Uint8Array> {
  const first = await embedPart(EMPTY_PART_LIBRARY, a, '板A.pcad', '', { importedAt: SAVED_AT });
  const second = await embedPart(first.library, b, `${b.name}.pcad`, '', { importedAt: SAVED_AT });
  let document = createAssemblyDocument('参照の直し');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: first.partRef },
    { partName: '板A', placement: placement(0, 0, 0) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: second.partRef },
    { partName: b.name, placement: placement(...B_AT) }));
  if (links !== undefined) document = { ...document, contextReferences: links };
  return writeDocumentBundle(createAssemblyDocumentBundle(document, second.library), { savedAt: SAVED_AT });
}

/** 保存した組立から、A の部品文書・P の座標・結び付けを読む。 */
async function savedContext(saved: Uint8Array) {
  const read = await readDocumentBundle(saved, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('保存した組立を読めません。');
  const bundle = read.bundle;
  const first = bundle.document.components[0];
  if (first?.source.kind !== 'part') throw new Error('A がありません。');
  const part = bundle.embeddedDocuments.get(first.source.partRef)?.document;
  const p = part?.references.find(feature => feature.id === P_ID);
  if (part === undefined || p?.kind !== 'referencePoint' || p.definition.kind !== 'coordinate' || p.definition.at.mode !== 'absolute') {
    throw new Error('P が座標の基準点ではありません。');
  }
  const { x, y, z } = p.definition.at;
  return { part, p: [x.value, y.value, z.value] as const, links: bundle.document.contextReferences ?? [] };
}

/** 実物の検査用ファイル口(PointerCadApp.tsx の `pcadSetFileGateway`)。route5 の spec と同じ形。 */
async function installGateway(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.pcadSetFileGateway === 'function', undefined, { timeout: 15_000 });
  await page.evaluate(() => {
    const install = window.pcadSetFileGateway;
    if (install === undefined) throw new Error('検査専用の口 pcadSetFileGateway が見つかりません。');
    install({
      openPcad: () => {
        const file = window.repairOpen ?? null;
        window.repairOpen = null;
        return Promise.resolve(file === null ? null : { name: file.name, bytes: new Uint8Array(file.bytes), saveTargetToken: null });
      },
      savePcad: (name, saved) => { window.repairSaved = [...saved]; return Promise.resolve(name); },
      hasSaveTarget: () => false,
      confirmSaveTarget: () => Promise.resolve(),
      clearSaveTarget: () => undefined,
    });
  });
}

function fileAction(page: Page, key: 'toolbar.file.open' | 'toolbar.file.save'): Locator {
  return page.getByRole('group', { name: uiMessage('toolbar', 'toolbar.file.title') })
    .getByRole('button', { name: uiMessage('toolbar', key), exact: true });
}

async function openBytes(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate((file) => { window.repairOpen = file; }, { name, bytes: [...bytes] });
  const token = await beginRecompute(page);
  await fileAction(page, 'toolbar.file.open').click();
  await waitForRecompute(page, token);
  expect(await page.evaluate(() => window.repairOpen ?? null)).toBeNull();
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

async function saveBytes(page: Page): Promise<Uint8Array> {
  await page.evaluate(() => { delete window.repairSaved; });
  await fileAction(page, 'toolbar.file.save').click();
  await expect.poll(() => page.evaluate(() => window.repairSaved?.length ?? 0)).toBeGreaterThan(0);
  return Uint8Array.from(await page.evaluate(() => window.repairSaved ?? []));
}

function contextForm(page: Page): Locator {
  return page.getByTestId('assembly-context-form');
}

async function selectComponent(page: Page, index: number): Promise<void> {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: uiMessage('assembly', 'assembly.tree.components') }) });
  const row = section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row').locator('.pcad-tree__select').nth(index);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

function expectPoint(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  expected.forEach((coordinate, axis) => expect(Math.abs((actual[axis] ?? Number.NaN) - coordinate)).toBeLessThanOrEqual(tolerance));
}

/** 箱(中心 B_AT、一辺 20)の 6 つの面の中心。 */
function boxFaceCenters(): readonly (readonly number[])[] {
  return [0, 1, 2].flatMap(axis => [-10, 10].map(offset => B_AT.map((coordinate, index) => index === axis ? coordinate + offset : coordinate)));
}

test.describe('EX-18 流れ5 参照の直し', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('元の部品を替えて古くなった参照は、更新しても理由を出して変えず、面を選び直すと同じ id で直り、1 回の Undo で戻る', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
      }
    });
    await page.goto('/');
    await installGateway(page);

    // 1) A と球の B を開き、P を B のただ 1 つの面に結ぶ。
    const plain = readPcadFile(writePcadFile(bracketPart(), { savedAt: SAVED_AT }));
    if (!plain.ok) throw new Error(plain.error.message);
    await openBytes(page, '参照の直し.pcada', await assemblyFile(plain.document, spherePart()));
    await selectComponent(page, 0);
    await expect(contextForm(page)).toBeVisible();
    await page.getByTestId('assembly-context-point').selectOption({ label: 'P' });
    await expect(page.getByTestId('assembly-context-face').locator('option')).toHaveCount(2);
    await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
    let token = await beginRecompute(page);
    await contextForm(page).getByRole('button', { name: uiMessage('assembly', 'assembly.context.create'), exact: true }).click();
    await waitForRecompute(page, token);
    await expect(contextForm(page).getByRole('alert')).toHaveCount(0);
    const linked = await savedContext(await saveBytes(page));
    expectPoint(linked.p, B_AT, 1e-9);
    expect(linked.links).toHaveLength(1);
    const [link] = linked.links;
    if (link === undefined) throw new Error('結び付けがありません。');
    expect(link.source.bodyFeatureId).toBe('sphere-1');

    // 2)・3) B を箱に替えた保存(A の部品・配置・結び付けは 1) のまま)を開き、「参照から更新」は理由を出して何も変えない。
    await openBytes(page, '参照の直し-箱.pcada', await assemblyFile(linked.part, boxPart(), linked.links));
    await selectComponent(page, 0);
    await expect(page.getByTestId('assembly-context-update')).toBeEnabled();
    await page.getByTestId('assembly-context-update').click();
    await expect(contextForm(page).getByRole('alert')).toHaveText(uiMessage('assembly', 'assembly.context.reason.sourceUnresolved'));
    await waitForSettledRecompute(page);
    const refused = await savedContext(await saveBytes(page));
    expectPoint(refused.p, B_AT, 1e-9);
    expect(refused.links).toEqual(linked.links);

    // 4) 箱の面を選び直して「参照を置き換える」。同じ id のまま、P は箱のどれかの面の中心になる。
    await expect(page.getByTestId('assembly-context-face').locator('option')).toHaveCount(7);
    await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
    token = await beginRecompute(page);
    await contextForm(page).getByRole('button', { name: uiMessage('assembly', 'assembly.context.replace'), exact: true }).click();
    await waitForRecompute(page, token);
    await expect(contextForm(page).getByRole('alert')).toHaveCount(0);
    const repaired = await savedContext(await saveBytes(page));
    expect(repaired.links.map(row => row.id)).toEqual([link.id]);
    expect(repaired.links[0]?.source.bodyFeatureId).toBe('box-1');
    const matches = boxFaceCenters().filter(center => center.every((coordinate, axis) => Math.abs((repaired.p[axis] ?? Number.NaN) - coordinate) <= 1e-6));
    expect(matches).toHaveLength(1);

    // 5) 元に戻す 1 回で、直す前の P と結び付けに戻る。
    token = await beginRecompute(page);
    await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
    await waitForRecompute(page, token);
    const undone = await savedContext(await saveBytes(page));
    expectPoint(undone.p, B_AT, 1e-9);
    expect(undone.links).toEqual(linked.links);
    expect(errors).toEqual([]);
  });
});
