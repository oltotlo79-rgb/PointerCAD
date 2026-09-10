/// <reference lib="dom" />
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { readDocumentBundle, writeDocumentBundle, writePcadFile } from '../../packages/io/src/index.js';
import {
  addComponent,
  appendSolid,
  createAssemblyDocument,
  createAssemblyDocumentBundle,
  createComponentFor,
  createEmptyPartDocument,
  createPrimitiveFeature,
  embedPart,
  EMPTY_PART_LIBRARY,
  type AssemblyDocument,
  type Mate,
  type PartDocument,
  type Placement,
  type PrimitiveShapeKind,
} from '../../packages/model/src/index.js';
import { expect, type Locator, type Page } from '@playwright/test';

const SAVED_AT = '2026-09-09T00:00:00.000Z';

export interface AssemblyBrowserStats {
  readonly components: readonly {
    readonly id: string;
    readonly name: string;
    readonly fixed: boolean;
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly resolved: { readonly position: readonly number[]; readonly rotation: readonly number[] } | null;
    readonly displayed: { readonly position: readonly number[]; readonly rotation: readonly number[] } | null;
  }[];
  readonly mateIds: readonly string[];
  readonly jointIds: readonly string[];
  readonly stepIds: readonly string[];
  readonly diagnosis: {
    readonly converged: boolean;
    readonly provenConflictMateIds: readonly string[];
    readonly suspectedConflictMateIds: readonly string[];
    readonly unresolvedMateIds: readonly string[];
  } | null;
  readonly jointValues: readonly { readonly key: string; readonly value: number }[];
  readonly interferenceSelectedKey: string | null;
}

declare global {
  interface Window {
    pcadSetFileGateway?: (gateway: E2eFileGateway) => void;
    pcadResetFileGateway?: () => void;
    pcadAssemblyStats?: () => AssemblyBrowserStats;
  }
}

interface E2ePickedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly saveTargetToken: string | null;
}

interface E2ePickedTypedFile {
  readonly kind: 'pcad';
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

interface E2eFileGateway {
  openPcad(kind?: 'part' | 'assembly' | 'all'): Promise<E2ePickedFile | null>;
  savePcad(suggestedName: string, bytes: Uint8Array, saveAs: boolean,
    kind?: 'part' | 'assembly'): Promise<string | null>;
  hasSaveTarget(): boolean;
  confirmSaveTarget?(token: string): Promise<void>;
  clearSaveTarget?(): void;
  openFile?(kinds: readonly string[]): Promise<E2ePickedTypedFile | null>;
  saveFileAs?(fileName: string, kind: string, bytes: Uint8Array): Promise<boolean>;
}

interface GatewayDocument {
  readonly name: string;
  readonly bytes: readonly number[];
}

interface GatewayTypedFile {
  readonly kind: 'pcad';
  readonly fileName: string;
  readonly bytes: readonly number[];
}

function cssString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** ツールバーの同名外枠を除き、実際に開いている浮動メニューだけを返す。 */
export function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator(
    `.pcad-toolbar .pcad-menu__panel[role="group"][aria-label=${cssString(menu)}]`,
  );
}

export async function openToolMenu(page: Page, menu: string): Promise<void> {
  const panel = toolMenuPanel(page, menu);
  if ((await panel.count()) === 0) {
    const trigger = page.locator('.pcad-toolbar')
      .getByRole('button', { name: new RegExp(`^${menu}`, 'u') }).first();
    // 廃止済みのメニュー名を使った場合にテスト全体のタイムアウトまで待たせない。
    await expect(trigger, `ツールバーに「${menu}」メニューがありません。`).toBeVisible({ timeout: 5_000 });
    await trigger.click();
  }
  await expect(panel).toBeVisible();
}

/** メニューの開閉と項目選択を一か所に集め、外枠の同名ARIA要素を誤って選ばない。 */
export async function chooseToolMenuItem(page: Page, menu: string, item: string): Promise<void> {
  await openToolMenu(page, menu);
  const button = toolMenuPanel(page, menu).getByRole('button', { name: item, exact: true });
  // メニューは存在しても項目名だけが古い場合に、試験全体の180秒上限まで待たせない。
  await expect(button, `「${menu}」メニューに「${item}」がありません。`).toBeVisible({ timeout: 5_000 });
  await button.click();
}

export async function installAssemblyFileGateway(page: Page, input: {
  readonly documents?: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly parts?: readonly { readonly fileName: string; readonly bytes: Uint8Array }[];
}): Promise<void> {
  const documents: GatewayDocument[] = (input.documents ?? []).map((file) => ({
    name: file.name,
    bytes: [...file.bytes],
  }));
  const parts: GatewayTypedFile[] = (input.parts ?? []).map((file) => ({
    kind: 'pcad',
    fileName: file.fileName,
    bytes: [...file.bytes],
  }));
  await page.evaluate(({ documents: queuedDocuments, parts: queuedParts }) => {
    const install = window.pcadSetFileGateway;
    if (install === undefined) throw new Error('検査専用の口 pcadSetFileGateway が見つかりません。');
    const documents = queuedDocuments.map((file) => ({
      name: file.name,
      bytes: new Uint8Array(file.bytes),
      saveTargetToken: null,
    }));
    const parts = queuedParts.map((file) => ({
      kind: file.kind,
      fileName: file.fileName,
      bytes: new Uint8Array(file.bytes),
    }));
    install({
      openPcad: () => Promise.resolve(documents.shift() ?? null),
      savePcad: (suggestedName) => Promise.resolve(suggestedName),
      hasSaveTarget: () => false,
      confirmSaveTarget: () => Promise.resolve(),
      clearSaveTarget: () => undefined,
      openFile: () => Promise.resolve(parts.shift() ?? null),
      saveFileAs: () => Promise.resolve(true),
    });
  }, { documents, parts });
}

export async function resetAssemblyFileGateway(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate(() => { window.pcadResetFileGateway?.(); });
}

export async function readAssemblyStats(page: Page): Promise<AssemblyBrowserStats> {
  return page.evaluate(() => {
    const read = window.pcadAssemblyStats;
    if (read === undefined) throw new Error('検査専用の口 pcadAssemblyStats が見つかりません。');
    return read();
  });
}

function primitivePart(name: string, kind: PrimitiveShapeKind): PartDocument {
  const empty = { ...createEmptyPartDocument(), name };
  return appendSolid(empty, createPrimitiveFeature(empty, kind));
}

export function boxPartFile(name = '箱'): Uint8Array {
  return writePcadFile(primitivePart(name, 'box'), { savedAt: SAVED_AT });
}

export function spherePartFile(name = '球'): Uint8Array {
  return writePcadFile(primitivePart(name, 'sphere'), { savedAt: SAVED_AT });
}

function placement(x: number, y = 0, z = 0): Placement {
  return {
    position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
    rotation: [0, 0, 0, 1],
  };
}

async function embeddedAssembly(
  name: string,
  parts: readonly { readonly name: string; readonly kind: PrimitiveShapeKind }[],
  putComponents: (document: AssemblyDocument, refs: readonly string[]) => AssemblyDocument,
): Promise<Uint8Array> {
  let library = EMPTY_PART_LIBRARY;
  const refs: string[] = [];
  for (const part of parts) {
    const result = await embedPart(
      library,
      primitivePart(part.name, part.kind),
      `${part.name}.pcad`,
      '',
      { importedAt: SAVED_AT },
    );
    library = result.library;
    refs.push(result.partRef);
  }
  const document = putComponents(createAssemblyDocument(name), refs);
  return writeDocumentBundle(createAssemblyDocumentBundle(document, library), { savedAt: SAVED_AT });
}

export function twoBoxAssemblyFile(secondX = 40): Promise<Uint8Array> {
  return embeddedAssembly('2部品', [{ name: '箱', kind: 'box' }], (empty, refs) => {
    const partRef = refs[0];
    if (partRef === undefined) throw new Error('箱の参照を作れませんでした。');
    let document = addComponent(empty, createComponentFor(empty,
      { kind: 'part', partRef }, { partName: '箱', placement: placement(0) }));
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef }, { partName: '箱', placement: placement(secondX) }));
    return document;
  });
}

/** 保存済みの同じ参照と配置IDを保持したまま3個目を追加する。 */
export async function addThirdBoxAssemblyFile(bytes: Uint8Array): Promise<Uint8Array> {
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('追加元の組立なし');
  const bundle = read.bundle, first = bundle.document.components[0];
  if (first?.source.kind !== 'part') throw new Error('追加元の部品参照なし');
  const document = addComponent(bundle.document, createComponentFor(bundle.document,
    { kind: 'part', partRef: first.source.partRef }, { partName: '箱', placement: placement(80) }));
  return writeDocumentBundle({ ...bundle, document }, { savedAt: SAVED_AT });
}

export function replacementAssemblyFile(): Promise<Uint8Array> {
  return embeddedAssembly('差し替え', [{ name: '箱', kind: 'box' }], (empty, refs) => {
    const partRef = refs[0];
    if (partRef === undefined) throw new Error('箱の参照を作れませんでした。');
    let document = addComponent(empty, createComponentFor(empty,
      { kind: 'part', partRef }, { partName: '箱', placement: placement(0) }));
    document = addComponent(document, createComponentFor(document,
      { kind: 'part', partRef }, { partName: '箱', placement: placement(40) }));
    const [first, second] = document.components;
    if (first === undefined || second === undefined) throw new Error('差し替え用の2部品を作れませんでした。');
    const valid: Mate = {
      id: 'mate-1', name: '原点の一致', kind: 'coincident',
      a: { kind: 'origin', componentId: first.id, element: 'origin' },
      b: { kind: 'origin', componentId: second.id, element: 'origin' },
      flipped: false, suppressed: false,
    };
    const unmatched: Mate = {
      id: 'mate-2', name: '選び直せない面', kind: 'coincident',
      a: { kind: 'subShape', componentId: first.id, ref: {
        bodyFeatureId: 'box-1', index: 999,
        fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1_000_000,
          position: [1_000_000, 1_000_000, 1_000_000], axis: [0, 0, 1], radius: null },
      } },
      b: { kind: 'origin', componentId: second.id, element: 'xy' },
      flipped: false, suppressed: false,
    };
    return { ...document, mates: [valid, unmatched] };
  });
}

export function distinctFiftyPartAssemblyFile(): Promise<Uint8Array> {
  const kinds: readonly PrimitiveShapeKind[] = ['box', 'sphere', 'cylinder', 'cone', 'torus'];
  const parts = Array.from({ length: 10 }, (_, index) => ({
    name: `性能部品${String(index + 1)}`,
    kind: kinds[index % kinds.length] ?? 'box',
  }));
  return embeddedAssembly('異なる10種50個', parts, (empty, refs) => {
    let document = empty;
    for (let partIndex = 0; partIndex < refs.length; partIndex += 1) {
      const partRef = refs[partIndex];
      if (partRef === undefined) continue;
      for (let instance = 0; instance < 5; instance += 1) {
        const ordinal = partIndex * 5 + instance;
        document = addComponent(document, createComponentFor(document,
          { kind: 'part', partRef }, {
            name: `性能部品${String(partIndex + 1)}:${String(instance + 1)}`,
            placement: placement((ordinal % 10) * 60, Math.floor(ordinal / 10) * 60),
          }));
      }
    }
    return document;
  });
}
