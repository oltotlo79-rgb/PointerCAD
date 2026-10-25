import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { readDocumentBundle, readPcadFile, writeDocumentBundle, writePcadFile } from '../../packages/io/src/index.js';
import {
  addComponent, appendReference, appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor,
  createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY, type Placement, type PrimitiveFeature, type ReferencePointFeature,
} from '../../packages/model/src/index.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

/*
 * EX-18 流れ5(組立の文脈の参照)を実際の画面で通す(candidate-12 の後継。前提を製品のソースで確かめ、B の移動を画面の
 * ドラッグに替えた)。自動の追従は無い前提で、当て直しは「参照から更新」を明示的に押す。
 *  1) 部品 A(板 40×30×10、基準点 P)を開き、P を選んで円形のメニューの「基準点に点を置く」→ その点に貫通穴 φ6。
 *     体積は画面のプロパティから読む(12000 − 90π)。A を保存する。
 *  2) 保存した A と、別の部品 B(球、中心が B の原点)を置いた組立を開く。A を選び、プロパティの
 *     「組立の中の参照」で P・B・B のただ1つの面を選んで「参照を作る」。保存した組立の A の P は B の位置 (10,15,10)。
 *  3) 選ぶものを「立体」(キー 4)にして、画面で B をドラッグして動かす。保存した組立の P は前のまま(自動では追従しない)。
 *     A を選んで「参照から更新」を押すと、P は B の新しい位置(組立の検査用の口 pcadAssemblyStats で読む B の配置)になる。
 *     結び付けの id は変わらず1つ、穴の点は P に相対のまま。
 * 期待の座標は配置と球の中心から決めた値(2 の (10,15,10) は手で決めた値、3 は B の配置そのもの)で、参照の計算の結果を写していない。
 */

const SAVED_AT = '2026-10-16T00:00:00.000Z';
const KERNEL_TIMEOUT_MS = 60_000;
const P_ID = 'refpoint-1';
const VOLUME = 40 * 30 * 10 - Math.PI * 9 * 10;
const value = (n: number) => expressionValueFromNumber(n);

declare global {
  interface Window {
    route5Saved?: number[];
    route5Open?: { readonly name: string; readonly bytes: number[] } | null;
  }
}

function placement(x: number, y: number, z: number): Placement {
  return { position: [value(x), value(y), value(z)], rotation: [0, 0, 0, 1] };
}

/** 部品 A: 板(中心 (20,15,5))と、まだどこにも結ばれていない基準点 P (10,15,0)。 */
function bracketPartFile(): Uint8Array {
  const plate: PrimitiveFeature = { id: 'box-1', name: '板', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(20), y: value(15), z: value(5) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: value(40), sizeY: value(30), sizeZ: value(10) } };
  const point: ReferencePointFeature = { id: P_ID, name: 'P', visible: true, kind: 'referencePoint',
    definition: { kind: 'coordinate', at: { mode: 'absolute', x: value(10), y: value(15), z: value(0) } } };
  const part = appendSolid(appendReference({ ...createEmptyPartDocument(), name: '板A' }, point), plate);
  return writePcadFile(part, { savedAt: SAVED_AT });
}

/** 部品 B: 球(中心 (0,0,0)、半径 2)。面は1枚で、面の中心は B の原点。 */
function spherePart() {
  const sphere: PrimitiveFeature = { id: 'sphere-1', name: '球', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(0), y: value(0), z: value(0) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'sphere', radius: value(2) } };
  return appendSolid({ ...createEmptyPartDocument(), name: '球B' }, sphere);
}

async function assemblyFile(bracketBytes: Uint8Array, b: Placement): Promise<Uint8Array> {
  const read = readPcadFile(bracketBytes);
  if (!read.ok) throw new Error(read.error.message);
  const a = await embedPart(EMPTY_PART_LIBRARY, read.document, '板A.pcad', '', { importedAt: SAVED_AT });
  const s = await embedPart(a.library, spherePart(), '球B.pcad', '', { importedAt: SAVED_AT });
  let document = createAssemblyDocument('流れ5');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: a.partRef },
    { partName: '板A', placement: placement(0, 0, 0) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: s.partRef },
    { partName: '球B', placement: b }));
  return writeDocumentBundle(createAssemblyDocumentBundle(document, s.library), { savedAt: SAVED_AT });
}

/** 保存した組立から、A の基準点 P の座標と結び付けを読む。 */
async function savedContext(saved: Uint8Array) {
  const read = await readDocumentBundle(saved, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('保存した組立を読めません。');
  const { document, embeddedDocuments } = read.bundle, first = document.components[0];
  if (first?.source.kind !== 'part') throw new Error('A がありません。');
  const part = embeddedDocuments.get(first.source.partRef)?.document;
  const p = part?.references.find(feature => feature.id === P_ID);
  if (p?.kind !== 'referencePoint' || p.definition.kind !== 'coordinate' || p.definition.at.mode !== 'absolute') {
    throw new Error('P が座標の基準点ではありません。');
  }
  const { x, y, z } = p.definition.at;
  const followsP = part?.sketches.some(sketch => sketch.features.some(feature => feature.kind === 'point'
    && feature.at.mode === 'relative' && feature.at.base.kind === 'point' && feature.at.base.pointId === P_ID)) ?? false;
  return { p: [x.value, y.value, z.value], links: document.contextReferences ?? [], followsP,
    hole: part?.solids.some(solid => solid.kind === 'hole') ?? false };
}

/** 実物の検査用ファイル口(PointerCadApp.tsx の `pcadSetFileGateway`)へ、開くバイトを渡し、保存したバイトを控える口を入れる。 */
async function installGateway(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.pcadSetFileGateway === 'function', undefined, { timeout: 15_000 });
  await page.evaluate(() => {
    const install = window.pcadSetFileGateway;
    if (install === undefined) throw new Error('検査専用の口 pcadSetFileGateway が見つかりません。');
    install({
      openPcad: () => {
        const file = window.route5Open ?? null;
        window.route5Open = null;
        return Promise.resolve(file === null ? null : { name: file.name, bytes: new Uint8Array(file.bytes), saveTargetToken: null });
      },
      savePcad: (name, saved) => { window.route5Saved = [...saved]; return Promise.resolve(name); },
      hasSaveTarget: () => false,
      confirmSaveTarget: () => Promise.resolve(),
      clearSaveTarget: () => undefined,
    });
  });
}

function fileAction(page: Page, name: string): Locator {
  return page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name, exact: true });
}

async function openBytes(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate((file) => { window.route5Open = file; }, { name, bytes: [...bytes] });
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  await waitForRecompute(page, token);
  expect(await page.evaluate(() => window.route5Open ?? null)).toBeNull();
}

async function saveBytes(page: Page): Promise<Uint8Array> {
  await page.evaluate(() => { delete window.route5Saved; });
  await fileAction(page, '保存').click();
  await expect.poll(() => page.evaluate(() => window.route5Saved?.length ?? 0)).toBeGreaterThan(0);
  return Uint8Array.from(await page.evaluate(() => window.route5Saved ?? []));
}

/* faceOffsetFlow.ts / solid.spec.ts と同じホーム視点の写し(押す場所の計算だけに使う)。 */
type WorldPoint = readonly [number, number, number];
const HOME_AZIMUTH = -Math.PI / 4, HOME_ELEVATION = Math.atan(Math.SQRT1_2), HOME_DISTANCE = 200;
const VERTICAL_FIELD_OF_VIEW = (50 * Math.PI) / 180;
const sub = (a: WorldPoint, b: WorldPoint): WorldPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: WorldPoint, b: WorldPoint): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: WorldPoint, b: WorldPoint): WorldPoint => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: WorldPoint): WorldPoint => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const EYE: WorldPoint = [HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH), HOME_DISTANCE * Math.sin(HOME_ELEVATION)];
const CZ = unit(EYE), CX = unit(cross([0, 0, 1], CZ)), CY = cross(CZ, CX);

async function worldOnScreen(page: Page, world: WorldPoint): Promise<readonly [number, number]> {
  const box = await page.locator('canvas.pcad-viewport__canvas').boundingBox();
  if (box === null) throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  const view = sub(world, EYE), depth = -dot(view, CZ), scale = 1 / Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
  const x = (scale * dot(view, CX)) / (depth * (box.width / box.height)), y = (scale * dot(view, CY)) / depth;
  return [box.x + ((x + 1) / 2) * box.width, box.y + ((1 - y) / 2) * box.height];
}

function treeRow(page: Page, name: string): Locator {
  return page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
}

async function expectVolume(page: Page, expected: number): Promise<void> {
  const cell = page.locator('.pcad-panel--right').locator('dt.pcad-properties__key', { hasText: '体積' })
    .locator('xpath=following-sibling::dd[1]');
  await expect.poll(async () => (await cell.count()) === 0 ? Number.NaN : Math.abs(Number.parseFloat(await cell.innerText()) - expected),
    { timeout: KERNEL_TIMEOUT_MS }).toBeLessThanOrEqual(0.01);
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

function expectPoint(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  expected.forEach((coordinate, axis) => expect(Math.abs((actual[axis] ?? Number.NaN) - coordinate)).toBeLessThanOrEqual(tolerance));
}

test.describe('EX-18 流れ5 組立の文脈の参照', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('基準点に点を置いて穴をあけ、組立で別の部品の面に結び、画面で動かした後に参照から更新する', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
      }
    });
    await page.goto('/');
    await installGateway(page);

    // 1) 部品 A を開き、P を選んで円形のメニューの「基準点に点を置く」。
    await openBytes(page, '板A.pcad', bracketPartFile());
    await treeRow(page, 'P').click();
    await page.mouse.click(...await worldOnScreen(page, [20, 15, 10]), { button: 'right' });
    const entry = page.locator('.pcad-radial-menu__item[data-command-id="sketch.pointAtReference"]');
    await expect(entry).toBeVisible();
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await entry.click();
    await expect(treeRow(page, '点1')).toBeVisible();

    // その点に貫通穴 φ6(faceOffsetFlow.ts の穴の手順と同じ)。
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^加工/u }).first().click();
    const hole = page.getByRole('group', { name: '加工' }).getByRole('button', { name: '穴', exact: true });
    await hole.click({ force: true });
    await expect(page.locator('.pcad-statusbar__state').first()).toHaveText('選ぶもの 面');
    await page.mouse.click(...await worldOnScreen(page, [20, 15, 10]));
    await treeRow(page, '点1').click({ modifiers: ['Shift'] });
    if ((await page.locator('.pcad-toolbar').getByRole('group', { name: '加工', exact: true }).count()) === 0) {
      await page.locator('.pcad-toolbar').getByRole('button', { name: /^加工/u }).first().click();
    }
    await hole.click();
    await expect(page.locator('.pcad-popover__title')).toHaveText('穴をあける');
    await page.locator('.pcad-popover').getByRole('switch', { name: '貫通', exact: true }).click();
    await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
    await expect(page.locator('.pcad-popover')).toHaveCount(0);
    await treeRow(page, '穴1').click();
    await expectVolume(page, VOLUME);
    const bracket = await saveBytes(page);

    // 2) A と B(B の位置 (10,15,10))を置いた組立を開き、P を B のただ1つの面に結ぶ。
    await openBytes(page, '流れ5.pcada', await assemblyFile(bracket, placement(10, 15, 10)));
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    await selectComponent(page, 0);
    await expect(contextForm(page)).toBeVisible();
    await page.getByTestId('assembly-context-point').selectOption({ label: 'P' });
    await expect(page.getByTestId('assembly-context-source').locator('option')).toHaveCount(1);
    // 0 番は「面を選ぶ」。球の面はただ1つなので選択肢は2つ(AssemblyContextReferenceForm.tsx 83-84)。
    const faceOptions = page.getByTestId('assembly-context-face').locator('option');
    await expect(faceOptions).toHaveCount(2);
    await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
    let token = await beginRecompute(page);
    await contextForm(page).getByRole('button', { name: '参照を作る', exact: true }).click();
    await waitForRecompute(page, token);
    await expect(page.getByTestId('assembly-context-update')).toBeVisible();
    await expect(contextForm(page).getByRole('alert')).toHaveCount(0);
    const linked = await savedContext(await saveBytes(page));
    expectPoint(linked.p, [10, 15, 10], 1e-9);
    expect(linked.links).toHaveLength(1);
    expect(linked.followsP).toBe(true);
    expect(linked.hole).toBe(true);

    // 3) 選ぶものを「立体」にし(commandDefinitions.ts の selection.body、キー 4)、B の球の上端を +X へドラッグする
    //    (attachAssemblyInteraction.ts 195-215・297-337: 部品の上で左を押すと選んで掴み、離すと確定する)。
    await page.locator('canvas.pcad-viewport__canvas').focus();
    await page.keyboard.press('4');
    await expect(page.locator('.pcad-statusbar__state').first()).toHaveText('選ぶもの 立体');
    const before = (await readAssemblyStats(page)).components[1]?.resolved?.position ?? [];
    expectPoint(before, [10, 15, 10], 1e-9);
    const grab = await worldOnScreen(page, [10, 15, 12]), drop = await worldOnScreen(page, [25, 15, 12]);
    await page.mouse.move(...grab);
    await page.mouse.down();
    await page.mouse.move(drop[0], drop[1], { steps: 8 });
    token = await beginRecompute(page);
    await page.mouse.up();
    await waitForRecompute(page, token);
    await expect(page.locator('.pcad-statusbar__text')).toHaveText('部品の移動を確定しました。');
    const moved = (await readAssemblyStats(page)).components[1]?.resolved?.position ?? [];
    expect(Math.abs((moved[0] ?? Number.NaN) - 10)).toBeGreaterThan(1);
    // 自動では追従しない: 保存した P は前のまま。
    expectPoint((await savedContext(await saveBytes(page))).p, [10, 15, 10], 1e-9);

    // 「参照から更新」を押すと、P は B の新しい位置(球の中心は B の原点)になる。
    await selectComponent(page, 0);
    await expect(page.getByTestId('assembly-context-update')).toBeEnabled();
    token = await beginRecompute(page);
    await page.getByTestId('assembly-context-update').click();
    await waitForRecompute(page, token);
    await expect(contextForm(page).getByRole('alert')).toHaveCount(0);
    const updated = await savedContext(await saveBytes(page));
    expectPoint(updated.p, moved, 1e-6);
    expect(updated.links.map(link => link.id)).toEqual(linked.links.map(link => link.id));
    expect(updated.followsP).toBe(true);
    expect(errors).toEqual([]);
  });
});
