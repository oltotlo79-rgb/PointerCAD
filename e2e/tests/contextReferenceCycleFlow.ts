import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { readDocumentBundle, readPcadFile, writeDocumentBundle, writePcadFile } from '../../packages/io/src/index.js';
import {
  addComponent, appendReference, appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor,
  createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY, type AssemblyDocumentBundle, type PartDocument, type Placement,
  type PrimitiveFeature, type ReferencePointFeature,
} from '../../packages/model/src/index.js';
import { expect, type Locator, type Page } from '@playwright/test';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

/*
 * EX-18 W09 組立の中の参照が循環する追加と置き換え(修復)を、画面で循環の理由を出して断る。ブラウザーは
 * context-reference-cycle-open.spec.ts、Electron は electron-context-reference-cycle.spec.ts から、同じ手順を呼ぶ
 * (faceOffsetFlow.ts と同じ形)。
 *  1) 部品 A(板と基準点 P)・B(球と基準点 Q)・C(箱)を置いた組立を、製品の「開く」で開く。
 *     「組立の中の参照」で A の P を B のただ 1 つの面に結ぶ(Undo 1 段目)。保存した結び付けは 1 本。
 *  2) 追加時: B の Q を A の板の面に結ぶ「参照を作る」は、A の点が B から決まっているので循環。循環の理由の文
 *     (assembly.context.reason.cyclicReference)が出て、保存した組立・部品の文書は 1) のまま。
 *  3) 循環しない対照: B の Q を C の箱の面に結ぶ「参照を作る」は受け付ける(Undo 2 段目)。結び付けは 2 本。
 *  4) 修復時: B の Q の結び付けの元を A の板の面へ「参照を置き換える」と、同じ id のまま循環になるので、循環の
 *     理由の文が出て、保存した組立・部品の文書は 3) のまま。
 *  5) 元に戻す 2 回で 3)・1) の結び付けが順に消え、それ以上は戻せない(断った 2 回は Undo の段を積まない)。
 * 部品と組立の作り方・検査用のファイル口は context-reference-cycle-open.spec.ts と同じ(spec は import できないので写した)。
 */

const SAVED_AT = '2026-10-25T00:00:00.000Z';
const P_ID = 'refpoint-1';
const Q_ID = 'refpoint-2';
const value = (n: number) => expressionValueFromNumber(n);

declare global {
  interface Window {
    cycleAddSaved?: number[];
    cycleAddOpen?: { readonly name: string; readonly bytes: number[] } | null;
  }
}

function placement(x: number, y: number, z: number): Placement {
  return { position: [value(x), value(y), value(z)], rotation: [0, 0, 0, 1] };
}

function referencePoint(id: string, name: string, x: number, y: number, z: number): ReferencePointFeature {
  return { id, name, visible: true, kind: 'referencePoint',
    definition: { kind: 'coordinate', at: { mode: 'absolute', x: value(x), y: value(y), z: value(z) } } };
}

function boxFeature(name: string, center: readonly [number, number, number], size: readonly [number, number, number]): PrimitiveFeature {
  return { id: 'box-1', name, suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(center[0]), y: value(center[1]), z: value(center[2]) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: value(size[0]), sizeY: value(size[1]), sizeZ: value(size[2]) } };
}

/** 製品の書き手と読み手を 1 回通した部品文書(開いた時と同じ形)。 */
function plain(document: PartDocument): PartDocument {
  const read = readPcadFile(writePcadFile(document, { savedAt: SAVED_AT }));
  if (!read.ok) throw new Error(read.error.message);
  return read.document;
}

/** 部品 A: 板(中心 (20,15,5)、40×30×10、面は 6 枚)と基準点 P (10,15,0)。 */
function bracketPart(): PartDocument {
  return appendSolid(appendReference({ ...createEmptyPartDocument(), name: '板A' }, referencePoint(P_ID, 'P', 10, 15, 0)),
    boxFeature('板', [20, 15, 5], [40, 30, 10]));
}

/** 部品 B: 球(中心 (0,0,0)、半径 2、面は 1 枚)と基準点 Q (0,0,0)。 */
function spherePart(): PartDocument {
  const sphere: PrimitiveFeature = { id: 'sphere-1', name: '球', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: { mode: 'absolute', x: value(0), y: value(0), z: value(0) } },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'sphere', radius: value(2) } };
  return appendSolid(appendReference({ ...createEmptyPartDocument(), name: '球B' }, referencePoint(Q_ID, 'Q', 0, 0, 0)), sphere);
}

/** 部品 C: 箱(中心 (0,0,0)、10×10×10、面は 6 枚)。基準点は持たない。 */
function cubePart(): PartDocument {
  return appendSolid({ ...createEmptyPartDocument(), name: '箱C' }, boxFeature('箱', [0, 0, 0], [10, 10, 10]));
}

/** A・B・C を置いた組立のバイトと、配置の名前(元の部品の選択肢の表示名)。 */
async function assemblyFile(): Promise<{ readonly bytes: Uint8Array; readonly names: readonly string[] }> {
  const a = await embedPart(EMPTY_PART_LIBRARY, plain(bracketPart()), '板A.pcad', '', { importedAt: SAVED_AT });
  const b = await embedPart(a.library, plain(spherePart()), '球B.pcad', '', { importedAt: SAVED_AT });
  const c = await embedPart(b.library, plain(cubePart()), '箱C.pcad', '', { importedAt: SAVED_AT });
  let document = createAssemblyDocument('循環の追加と置き換え');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: a.partRef },
    { partName: '板A', placement: placement(0, 0, 0) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: b.partRef },
    { partName: '球B', placement: placement(10, 15, 10) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: c.partRef },
    { partName: '箱C', placement: placement(60, 0, 0) }));
  return { bytes: await writeDocumentBundle(createAssemblyDocumentBundle(document, c.library), { savedAt: SAVED_AT }),
    names: document.components.map(component => component.name) };
}

async function savedAssembly(saved: Uint8Array): Promise<AssemblyDocumentBundle> {
  const read = await readDocumentBundle(saved, 'assembly');
  // 断られた時は、製品の読み手が返した理由(code と文言)をそのまま失敗に載せる(次の切り分けのため)。
  if (!read.ok) throw new Error(`保存した組立を読めません(${read.error.code}: ${read.error.message})。`);
  if (read.bundle.kind !== 'assembly') throw new Error(`保存したものが組立ではありません(${read.bundle.kind})。`);
  return read.bundle;
}

/** 保存した組立の中身: 配置・結び付けを持つ組立文書と、抱き込んだ部品の文書(保存の日時は封筒にあり、ここに入らない)。 */
function contentOf(bundle: AssemblyDocumentBundle) {
  return { document: bundle.document, parts: [...bundle.embeddedDocuments].map(([ref, part]) => [ref, part.document] as const) };
}

/** 実物の検査用ファイル口(PointerCadApp.tsx の `pcadSetFileGateway`)。context-reference-repair.spec.ts と同じ形。 */
async function installGateway(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.pcadSetFileGateway === 'function', undefined, { timeout: 15_000 });
  await page.evaluate(() => {
    const install = window.pcadSetFileGateway;
    if (install === undefined) throw new Error('検査専用の口 pcadSetFileGateway が見つかりません。');
    install({
      openPcad: () => {
        const file = window.cycleAddOpen ?? null;
        window.cycleAddOpen = null;
        return Promise.resolve(file === null ? null : { name: file.name, bytes: new Uint8Array(file.bytes), saveTargetToken: null });
      },
      savePcad: (name, saved) => { window.cycleAddSaved = [...saved]; return Promise.resolve(name); },
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
  await page.evaluate((file) => { window.cycleAddOpen = file; }, { name, bytes: [...bytes] });
  const token = await beginRecompute(page);
  await fileAction(page, 'toolbar.file.open').click();
  await waitForRecompute(page, token);
  expect(await page.evaluate(() => window.cycleAddOpen ?? null)).toBeNull();
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

async function saveBytes(page: Page): Promise<Uint8Array> {
  await page.evaluate(() => { delete window.cycleAddSaved; });
  await fileAction(page, 'toolbar.file.save').click();
  await expect.poll(() => page.evaluate(() => window.cycleAddSaved?.length ?? 0)).toBeGreaterThan(0);
  return Uint8Array.from(await page.evaluate(() => window.cycleAddSaved ?? []));
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

/** 元の部品を名前で選び、その部品の面の選択肢(「面を選ぶ」＋面の数)を確かめて、最初の面を選ぶ。 */
async function chooseSourceFace(page: Page, sourceName: string, faceOptions: number): Promise<void> {
  await page.getByTestId('assembly-context-source').selectOption({ label: sourceName });
  await expect(page.getByTestId('assembly-context-face').locator('option')).toHaveCount(faceOptions);
  await page.getByTestId('assembly-context-face').selectOption({ index: 1 });
}

/** 確定のボタンを押し、作り直しを待って、理由の文が出ていないことを確かめる。 */
async function commitAccepted(page: Page, button: Locator): Promise<void> {
  const token = await beginRecompute(page);
  await button.click();
  await waitForRecompute(page, token);
  await expect(contextForm(page).getByRole('alert')).toHaveCount(0);
}

async function undoOnce(page: Page, undoButton: Locator): Promise<void> {
  const token = await beginRecompute(page);
  await undoButton.click();
  await waitForRecompute(page, token);
}

/**
 * 循環になる参照の追加と置き換えを、循環の理由を出して断る。`entry` はブラウザーでは '/'(preview)、Electron では製品の
 * 入口 'app://pointercad/index.html'(apps/desktop/src/main/appProtocol.ts の APP_ENTRY_URL)。
 */
export async function contextReferenceCycleFlow(page: Page, entry: string): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry);
  await installGateway(page);
  const undoButton = page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true });
  const createButton = contextForm(page).getByRole('button', { name: uiMessage('assembly', 'assembly.context.create'), exact: true });
  const replaceButton = contextForm(page).getByRole('button', { name: uiMessage('assembly', 'assembly.context.replace'), exact: true });
  const cyclicReason = uiMessage('assembly', 'assembly.context.reason.cyclicReference');
  const { bytes, names } = await assemblyFile();
  const [nameA, nameB, nameC] = names;
  if (nameA === undefined || nameB === undefined || nameC === undefined) throw new Error('配置の名前がありません。');

  // 1) A の P を B のただ 1 つの面に結ぶ(Undo 1 段目)。保存した結び付けは 1 本で、先は A の P、元は B の球の面。
  await openBytes(page, '循環の追加と置き換え.pcada', bytes);
  await selectComponent(page, 0);
  await expect(contextForm(page)).toBeVisible();
  await page.getByTestId('assembly-context-point').selectOption({ label: 'P' });
  await chooseSourceFace(page, nameB, 2);
  await commitAccepted(page, createButton);
  const linked = await savedAssembly(await saveBytes(page));
  const [first, ...rest] = linked.document.contextReferences ?? [];
  if (first === undefined) throw new Error('結び付けがありません。');
  expect(rest).toEqual([]);
  expect([first.targetReferenceId, first.source.bodyFeatureId]).toEqual([P_ID, 'sphere-1']);
  await expect(undoButton).toHaveAttribute('aria-disabled', 'false');

  // 2) 追加時: B の Q を A の板の面に結ぶ。元に選べるのは A と C で、A の板の面は 6 枚。循環の理由が出て、文書は 1) のまま。
  await selectComponent(page, 1);
  await expect(contextForm(page)).toBeVisible();
  await page.getByTestId('assembly-context-point').selectOption({ label: 'Q' });
  await expect(page.getByTestId('assembly-context-source').locator('option')).toHaveCount(2);
  await chooseSourceFace(page, nameA, 7);
  await createButton.click();
  await expect(contextForm(page).getByRole('alert')).toHaveText(cyclicReason);
  await waitForSettledRecompute(page);
  expect(contentOf(await savedAssembly(await saveBytes(page)))).toEqual(contentOf(linked));

  // 3) 循環しない対照: B の Q を C の箱の面に結ぶ(Undo 2 段目)。結び付けは 2 本で、2 本目の元は C の箱。
  await chooseSourceFace(page, nameC, 7);
  await commitAccepted(page, createButton);
  const both = await savedAssembly(await saveBytes(page));
  const [kept, second, ...more] = both.document.contextReferences ?? [];
  if (second === undefined) throw new Error('2 本目の結び付けがありません。');
  expect([kept, more]).toEqual([first, []]);
  expect([second.targetReferenceId, second.source.bodyFeatureId, second.sourceComponentId])
    .toEqual([Q_ID, 'box-1', both.document.components[2]?.id]);

  // 4) 修復時: B の Q の結び付けの元を A の板の面へ置き換える。同じ id のまま循環になるので、循環の理由が出て、文書は 3) のまま。
  await expect(replaceButton).toBeVisible();
  await chooseSourceFace(page, nameA, 7);
  await replaceButton.click();
  await expect(contextForm(page).getByRole('alert')).toHaveText(cyclicReason);
  await waitForSettledRecompute(page);
  expect(contentOf(await savedAssembly(await saveBytes(page)))).toEqual(contentOf(both));

  // 5) 元に戻す 2 回で、3) と 1) の結び付けが順に消え、それ以上は戻せない(断った 2 回は Undo の段を積まない)。
  await undoOnce(page, undoButton);
  expect((await savedAssembly(await saveBytes(page))).document.contextReferences ?? []).toEqual([first]);
  await undoOnce(page, undoButton);
  const undone = await savedAssembly(await saveBytes(page));
  expect(undone.document.contextReferences ?? []).toEqual([]);
  expect(undone.document.components).toEqual(linked.document.components);
  await expect(undoButton).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
}
