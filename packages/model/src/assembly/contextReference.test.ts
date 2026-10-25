import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createUndoStack, pushUndo, undo, type UndoStack } from '../history/undoStack.js';
import { resolveSubShapeReference } from '../kernelBridge/referenceResolution.js';
import type { SolidBody } from '../kernelBridge/solidContracts.js';
import { appendReference, createEmptyPartDocument, findReference } from '../part/createPartDocument.js';
import type { PartDocument, ReferencePointFeature } from '../part/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { addComponent, createComponentFor } from './assemblyEdit.js';
import {
  applyContextReference, commitContextReference, type ContextReferenceContext, type ContextReferenceLink,
  contextPointResolverFromBodies, contextReferencesHaveCycle,
} from './contextReference.js';
import { createAssemblyDocument } from './createAssemblyDocument.js';
import { embedPart, type PartLibrary } from './partLibrary.js';
import type { AssemblyComponent, AssemblyDocument, Placement } from './types.js';

const HALF = Math.SQRT1_2;

function placement(position: Vec3, rotation: readonly [number, number, number, number] = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation };
}

const POINT: ReferencePointFeature = { id: 'point-1', name: '点1', visible: true, kind: 'referencePoint',
  definition: { kind: 'coordinate', at: { mode: 'absolute', x: expressionValueFromNumber(0),
    y: expressionValueFromNumber(0), z: expressionValueFromNumber(0) } } };

/** Bの穴の面(中心を使う)。 */
const HOLE_FACE: SubShapeRef = { bodyFeatureId: 'extrude-1', index: 3, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
  area: 10, position: [5, 0, 0], axis: [0, 0, 1], radius: 2 } };

/** A(板)と B(受け)を置いた組立。Aの部品に基準点を1つ持つ。 */
function scene(bPlacement: Placement = placement([100, 0, 0], [0, 0, HALF, HALF])) {
  let document: AssemblyDocument = createAssemblyDocument('文脈');
  const a: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: 'bracket' }),
    placement: placement([10, 20, 0]) };
  document = addComponent(document, a);
  const b: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: 'base' }), placement: bPlacement };
  document = addComponent(document, b);
  const parts = new Map<string, PartDocument>([
    ['bracket', appendReference(createEmptyPartDocument(), POINT)], ['base', createEmptyPartDocument()]]);
  const context = (links: readonly ContextReferenceLink[] = [], point: Vec3 | null = [5, 0, 0]): ContextReferenceContext => ({
    document, links,
    partDocument: (component) => component.source.kind === 'part' ? parts.get(component.source.partRef) ?? null : null,
    resolvePoint: (component, reference) => component.id === b.id && reference === HOLE_FACE ? point : null,
  });
  const link: ContextReferenceLink = { id: 'context-1', targetComponentId: a.id, targetReferenceId: 'point-1',
    sourceComponentId: b.id, source: HOLE_FACE };
  return { document, a, b, parts, context, link };
}

function coordinateOf(part: PartDocument): Vec3 {
  const feature = findReference(part, 'point-1');
  if (feature?.kind !== 'referencePoint' || feature.definition.kind !== 'coordinate'
    || feature.definition.at.mode !== 'absolute') throw new Error('point');
  const { x, y, z } = feature.definition.at;
  return [x.value, y.value, z.value];
}

function expectClose(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(1e-9));
}

describe('組立の文脈の参照: Bの面の中心をAの部品の座標の基準点にする', () => {
  it('Bの配置(回転と移動)で組立へ写し、Aの配置の逆で戻した点を、Aの部品の基準点に書く', () => {
    const { context, link, parts } = scene();
    const before = JSON.stringify([...parts]);
    const result = applyContextReference(context(), link);
    if ('code' in result) throw new Error(JSON.stringify(result));
    // B: (5,0,0) を z 軸まわりに 90° → (0,5,0)、移動 (100,0,0) → 組立 (100,5,0)。A の逆 (−10,−20,0) → (90,−15,0)。
    expectClose(result.point, [90, -15, 0]);
    expect(result.partRef).toBe('bracket');
    expectClose(coordinateOf(result.part), [90, -15, 0]);
    // 書くのは新しい部品文書だけ。渡した文書と元の部品は変えない。
    expect(JSON.stringify([...parts])).toBe(before);
  });

  it('Bを動かして更新すると、同じ結び付けから点が追従する', () => {
    const moved = scene(placement([0, 50, 0]));
    const result = applyContextReference(moved.context(), moved.link);
    if ('code' in result) throw new Error(JSON.stringify(result));
    expectClose(result.point, [-5, 30, 0]);
  });

  it.each<readonly [string, (s: ReturnType<typeof scene>) => [ContextReferenceContext, ContextReferenceLink]]>([
    ['sourceComponentMissing', (s) => [s.context(), { ...s.link, sourceComponentId: 'component-99' }]],
    ['targetComponentMissing', (s) => [s.context(), { ...s.link, targetComponentId: 'component-99' }]],
    ['targetReferenceMissing', (s) => [s.context(), { ...s.link, targetReferenceId: 'point-9' }]],
    ['sourceUnresolved', (s) => [s.context([], null), s.link]],
    ['cyclicReference', (s) => [s.context([{ id: 'context-0', targetComponentId: s.b.id, targetReferenceId: 'point-1',
      sourceComponentId: s.a.id, source: HOLE_FACE }]), s.link]],
    ['samePart', (s) => [s.context(), { ...s.link, sourceComponentId: s.a.id }]],
    // 同じ部品を置いた別の配置があると、書けばその配置も動く。
    ['targetPartShared', (s) => [{ ...s.context(), document: addComponent(s.document,
      createComponentFor(s.document, { kind: 'part', partRef: 'bracket' })) }, s.link]],
    ['duplicateTarget', (s) => [s.context([{ ...s.link, id: 'context-0' }]), s.link]],
  ])('%s は断り、部品文書を作らない', (code, build) => {
    const s = scene();
    const before = JSON.stringify([...s.parts]);
    const [context, link] = build(s);
    expect(applyContextReference(context, link)).toEqual({ code, linkId: link.id });
    expect(JSON.stringify([...s.parts])).toBe(before);
  });

  it('確定: 抱き込んだ部品の一式を差し替え、結び付けを組立に残す。同じ id の更新は置き換え、断る時は何も作らない', async () => {
    const empty: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
    const bracket = await embedPart(empty, appendReference(createEmptyPartDocument(), POINT), 'bracket.pcad', 'bracket.pcad');
    const base = await embedPart(bracket.library, appendReference(createEmptyPartDocument(), { ...POINT, id: 'base-point' }),
      'base.pcad', 'base.pcad');
    let document: AssemblyDocument = createAssemblyDocument('確定');
    const a: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: bracket.partRef }),
      placement: placement([10, 20, 0]) };
    document = addComponent(document, a);
    const b: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: base.partRef }),
      placement: placement([0, 50, 0]) };
    document = addComponent(document, b);
    const resolvePoint: ContextReferenceContext['resolvePoint'] = (component, reference) =>
      component.id === b.id && reference === HOLE_FACE ? [5, 0, 0] : null;
    const link: ContextReferenceLink = { id: 'context-1', targetComponentId: a.id, targetReferenceId: 'point-1',
      sourceComponentId: b.id, source: HOLE_FACE };
    const before = JSON.stringify([document, base.library.partFiles]);
    const first = await commitContextReference(document, base.library, link, resolvePoint);
    if ('code' in first) throw new Error(JSON.stringify(first));
    expect(first.document.contextReferences).toEqual([link]);
    const written = first.library.parts.get(bracket.partRef);
    if (written === undefined) throw new Error('part');
    expectClose(coordinateOf(written), [-5, 30, 0]);
    // 元の部品(B)と、配置・部品の id は変えない。
    expect(first.library.parts.get(base.partRef)).toBe(base.library.parts.get(base.partRef));
    expect(first.document.components).toEqual(document.components);
    expect(first.library.partFiles.find((file) => file.ref === bracket.partRef)?.contentHash)
      .not.toBe(base.library.partFiles.find((file) => file.ref === bracket.partRef)?.contentHash);
    expect(JSON.stringify([document, base.library.partFiles])).toBe(before);
    // Bを動かして同じ結び付けを更新すると、置き換わって点が追従する(結び付けは増えない)。
    const movedDocument = { ...first.document, components: first.document.components.map((component) =>
      component.id === b.id ? { ...component, placement: placement([0, 60, 0]) } : component) };
    const second = await commitContextReference(movedDocument, first.library, link, resolvePoint);
    if ('code' in second) throw new Error(JSON.stringify(second));
    expect(second.document.contextReferences).toEqual([link]);
    expectClose(second.point, [-5, 40, 0]);
    // 循環になる逆向きの結び付けは断り、組立も一式も作らない。
    const reverse: ContextReferenceLink = { id: 'context-2', targetComponentId: b.id, targetReferenceId: 'base-point',
      sourceComponentId: a.id, source: HOLE_FACE };
    expect(await commitContextReference(second.document, second.library, reverse, resolvePoint))
      .toEqual({ code: 'cyclicReference', linkId: 'context-2' });
  });

  it('表示の配列が local の原点(1000,0,0)で平行移動していても、面の中心は部品の座標のまま使う', () => {
    const face = (index: number, surfaceKind: 'plane' | 'cylinder', centroid: Vec3) => ({ index, surfaceKind,
      area: 10, centroid, axis: [0, 0, 1] as Vec3, radius: surfaceKind === 'cylinder' ? 2 : null,
      triangleOffset: 0, triangleCount: 0 });
    const world: SolidBody = { featureId: 'extrude-1', mesh: { positions: new Float32Array([0, 0, 0, 10, 10, 10]),
      normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    volume: 1, isValid: true, edges: [], vertices: [], threadMarks: [],
    faces: [face(0, 'plane', [5, 5, 0]), face(1, 'plane', [5, 5, 10]), face(2, 'plane', [0, 5, 5]),
      face(3, 'cylinder', [5, 0, 0])] };
    const local: SolidBody = { ...world, coordinateFrame: { space: 'local', origin: [1000, 0, 0], maximumFloat32ErrorMm: 1e-3 },
      mesh: { ...world.mesh, positions: new Float32Array([-1000, 0, 0, -990, 10, 10]) } };
    const component = createComponentFor(createAssemblyDocument('枠'), { kind: 'part', partRef: 'base' });
    for (const body of [world, local]) {
      expect(contextPointResolverFromBodies(() => [body], resolveSubShapeReference)(component, HOLE_FACE)).toEqual([5, 0, 0]);
    }
    // 同じ id のボディが2つ、または無効なボディなら点を返さない。
    expect(contextPointResolverFromBodies(() => [world, local], resolveSubShapeReference)(component, HOLE_FACE)).toBeNull();
    expect(contextPointResolverFromBodies(() => [{ ...world, isValid: false }], resolveSubShapeReference)(component, HOLE_FACE))
      .toBeNull();
  });

  it('抑制した元の部品は無いものとして断る', () => {
    const s = scene();
    const document = { ...s.document, components: s.document.components.map((component) =>
      component.id === s.b.id ? { ...component, suppressed: true } : component) };
    expect(applyContextReference({ ...s.context(), document }, s.link)).toEqual({ code: 'sourceComponentMissing', linkId: 'context-1' });
  });
});

describe('結び付けの循環(保存を開く時と確定の時の同じ判定)', () => {
  /** 部品の ref を順に置いた組立。同じ ref を2回渡すと、同じ部品の別の配置になる。 */
  function placed(partRefs: readonly string[]): { readonly document: AssemblyDocument; readonly ids: readonly string[] } {
    let document: AssemblyDocument = createAssemblyDocument('循環');
    const ids: string[] = [];
    for (const partRef of partRefs) {
      const component = createComponentFor(document, { kind: 'part', partRef });
      document = addComponent(document, component);
      ids.push(component.id);
    }
    return { document, ids };
  }

  /** 先 ids[target] の点1を、元 ids[source] の穴の面から決める結び付け。 */
  function links(ids: readonly string[], pairs: readonly (readonly [number, number])[]): ContextReferenceLink[] {
    return pairs.map(([target, source], index) => {
      const targetComponentId = ids[target], sourceComponentId = ids[source];
      if (targetComponentId === undefined || sourceComponentId === undefined) throw new Error('component');
      return { id: `context-${String(index + 1)}`, targetComponentId, targetReferenceId: 'point-1', sourceComponentId,
        source: HOLE_FACE };
    });
  }

  it('循環の無い一本道と、同じ部品を2か所に置いた元は循環ではない', () => {
    const chain = placed(['part-1', 'part-2', 'part-3']);
    expect(contextReferencesHaveCycle(chain.document, links(chain.ids, [[0, 1], [1, 2]]))).toBe(false);
    const shared = placed(['part-1', 'part-2', 'part-3', 'part-2']);
    expect(contextReferencesHaveCycle(shared.document, links(shared.ids, [[0, 1], [2, 3]]))).toBe(false);
    expect(contextReferencesHaveCycle(chain.document, [])).toBe(false);
  });

  it.each<readonly [string, readonly string[], readonly (readonly [number, number])[]]>([
    ['2本の循環', ['part-1', 'part-2'], [[0, 1], [1, 0]]],
    ['3本の循環', ['part-1', 'part-2', 'part-3'], [[0, 1], [1, 2], [2, 0]]],
    ['同じ部品の別の配置どうし', ['part-1', 'part-1'], [[0, 1]]],
    ['同じ部品の別の配置を通る2本の循環', ['part-1', 'part-2', 'part-1'], [[0, 1], [1, 2]]],
  ])('%s は循環', (_case, partRefs, pairs) => {
    const { document, ids } = placed(partRefs);
    expect(contextReferencesHaveCycle(document, links(ids, pairs))).toBe(true);
  });

  it('3本の循環の1本を確定すると、同じ判定の cyclicReference で断る', () => {
    const { document, ids } = placed(['part-1', 'part-2', 'part-3']);
    const all = links(ids, [[0, 1], [1, 2], [2, 0]]);
    const [first] = all;
    if (first === undefined) throw new Error('link');
    const context: ContextReferenceContext = { document, links: all, partDocument: () => null, resolvePoint: () => null };
    expect(applyContextReference(context, first)).toEqual({ code: 'cyclicReference', linkId: first.id });
  });

  /** 1000 個の配置。i 番は部品 part-i(`shared` を渡した番は全て同じ部品 shared の別の配置)。 */
  function many(shared: (index: number) => boolean = () => false) {
    return placed(Array.from({ length: 1000 }, (_, index) => shared(index) ? 'shared' : `part-${String(index)}`));
  }

  it('1000 部品の一本道・枝の多い DAG・同じ部品を 999 か所に置いた元は循環ではない', () => {
    const chain = many();
    const chainLinks = links(chain.ids, Array.from({ length: 999 }, (_, i) => [i, i + 1] as const));
    expect(contextReferencesHaveCycle(chain.document, chainLinks)).toBe(false);
    const dagPairs: (readonly [number, number])[] = [];
    for (let i = 0; i < 998; i += 1) dagPairs.push([i, i + 1], [i, i + 2]);
    expect(contextReferencesHaveCycle(chain.document, links(chain.ids, dagPairs))).toBe(false);
    const fan = many((index) => index > 0);
    expect(contextReferencesHaveCycle(fan.document, links(fan.ids, Array.from({ length: 999 }, (_, i) => [0, i + 1] as const))))
      .toBe(false);
  });

  it('1000 部品の一本道の最後で閉じる循環と、共有の部品へ戻る循環を見つける', () => {
    const chain = many();
    const pairs = Array.from({ length: 999 }, (_, i) => [i, i + 1] as const);
    expect(contextReferencesHaveCycle(chain.document, links(chain.ids, [...pairs, [999, 0]]))).toBe(true);
    const fan = many((index) => index > 0);
    const fanPairs = Array.from({ length: 999 }, (_, i) => [0, i + 1] as const);
    expect(contextReferencesHaveCycle(fan.document, links(fan.ids, [...fanPairs, [500, 0]]))).toBe(true);
  });

  it('1000 部品の一本道を閉じる 1 本の確定は cyclicReference、閉じない 1 本は循環の確かめを通る', () => {
    const chain = many();
    const all = links(chain.ids, [...Array.from({ length: 999 }, (_, i) => [i, i + 1] as const), [999, 0]]);
    const closing = all.at(-1);
    if (closing === undefined) throw new Error('link');
    const context: ContextReferenceContext = { document: chain.document, links: all, partDocument: () => null, resolvePoint: () => null };
    expect(applyContextReference(context, closing)).toEqual({ code: 'cyclicReference', linkId: closing.id });
    // 閉じる 1 本を除けば循環は無い。一本道の最後の 1 本は循環の確かめを通り、その後の部品文書の確かめで断られる。
    const open = { ...context, links: all.slice(0, -1) };
    const tail = all.slice(0, -1).at(-1);
    if (tail === undefined) throw new Error('link');
    expect(applyContextReference(open, tail)).toEqual({ code: 'targetReferenceMissing', linkId: tail.id });
  });
});

describe('EX18 rejected commits preserve the complete assembly inputs', () => {
  it.each(['sourceComponentMissing', 'sourceUnresolved', 'cyclicReference', 'targetPartShared'] as const)(
    '%s keeps placements, existing links, parts, attachment bytes and file metadata unchanged', async code => {
      const s = scene();
      const existing: ContextReferenceLink = { ...s.link, id: 'already-saved', targetReferenceId: 'another-point' };
      let document: AssemblyDocument = { ...s.document, contextReferences: [existing] };
      if (code === 'cyclicReference') document = { ...document, contextReferences: [{ ...existing,
        targetComponentId: s.b.id, sourceComponentId: s.a.id }] };
      if (code === 'targetPartShared') document = addComponent(document,
        createComponentFor(document, { kind: 'part', partRef: 'bracket' }));
      const preservedBytes = new Uint8Array([10, 20, 30]);
      const preservedAttachments: import('./partLibrary.js').EmbeddedPartAttachments = {
        shapes: new Map([['preserved.brep', preservedBytes]]), meshes: new Map(), canvases: new Map(),
      };
      const library: PartLibrary = { partFiles: [], parts: s.parts,
        attachments: new Map([['bracket', preservedAttachments]]) };
      const link = code === 'sourceComponentMissing' ? { ...s.link, sourceComponentId: 'missing-source' } : s.link;
      const parts = [...library.parts], attachments = [...library.attachments];
      const snapshot = JSON.stringify([document, library.partFiles, parts, attachments]);
      const components = document.components, links = document.contextReferences;
      const result = await commitContextReference(document, library, link, () => null);
      expect(result).toEqual({ code, linkId: link.id });
      expect(JSON.stringify([document, library.partFiles, [...library.parts], [...library.attachments]])).toBe(snapshot);
      expect(document.components).toBe(components); expect(document.contextReferences).toBe(links);
      for (const [ref, part] of parts) expect(library.parts.get(ref)).toBe(part);
      for (const [ref, bytes] of attachments) expect(library.attachments.get(ref)).toBe(bytes);
      expect(library.attachments.get('bracket')?.shapes.get('preserved.brep')).toBe(preservedBytes);
      expect(Array.from(preservedBytes)).toEqual([10, 20, 30]);
    },
  );
});

describe('EX18 W09 追加の確定: 循環は断って文書・一式・Undo の履歴を変えず、循環しない追加は 1 段で受ける', () => {
  /** 画面の組立の Undo の 1 段(packages/ui の AssemblySnapshot と同じ形)。 */
  interface Snapshot { readonly document: AssemblyDocument; readonly library: PartLibrary }
  /** 結び付けの組(先の配置の番号, 元の配置の番号)。 */
  type Pair = readonly [number, number];
  const IMPORTED_AT = '2026-10-25T00:00:00.000Z';
  /** 元の面の中心(部品の座標)。配置は全て既定(原点・回転なし)なので、先の部品へ書く点も同じ。 */
  const SOURCE_POINT: Vec3 = [5, 0, 0];
  const THOUSAND = Array.from({ length: 1000 }, (_, index) => `部品${String(index)}`);
  /** 配置 0←1←…←length の一本道(先 i の点を元 i+1 から決める)。 */
  const chain = (length: number): Pair[] => Array.from({ length }, (_, index) => [index, index + 1] as const);

  /**
   * 名札を順に置いた組立。名札ごとに基準点 point-1 を持つ別の部品文書を抱き込み、同じ名札は同じ部品(partRef)の
   * 別の配置にする。`existing` を保存済みの結び付けにする。
   */
  async function sceneOf(labels: readonly string[], existing: readonly Pair[]) {
    let library: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
    const refs = new Map<string, string>();
    for (const label of labels) {
      if (refs.has(label)) continue;
      const embedded = await embedPart(library, { ...appendReference(createEmptyPartDocument(), POINT), name: label },
        `${label}.pcad`, `${label}.pcad`, { importedAt: IMPORTED_AT });
      library = embedded.library;
      refs.set(label, embedded.partRef);
    }
    let document: AssemblyDocument = createAssemblyDocument('W09');
    const ids: string[] = [];
    for (const label of labels) {
      const partRef = refs.get(label);
      if (partRef === undefined) throw new Error('part');
      const component = createComponentFor(document, { kind: 'part', partRef });
      document = addComponent(document, component);
      ids.push(component.id);
    }
    const linkOf = ([target, source]: Pair, index: number): ContextReferenceLink => {
      const targetComponentId = ids[target], sourceComponentId = ids[source];
      if (targetComponentId === undefined || sourceComponentId === undefined) throw new Error('component');
      return { id: `w09-${String(index + 1)}`, targetComponentId, targetReferenceId: 'point-1', sourceComponentId,
        source: HOLE_FACE };
    };
    const snapshot: Snapshot = { document: { ...document, contextReferences: existing.map(linkOf) }, library };
    return { snapshot, ids, linkOf };
  }

  /** 前に 2 段・先に 1 段ある履歴の、今の段を `current` にする(空の履歴では不変を確かめたことにならない)。 */
  function historyAt(current: Snapshot): UndoStack<Snapshot> {
    const renamed = (name: string): Snapshot => ({ ...current, document: { ...current.document, name } });
    let stack = createUndoStack<Snapshot>({ ...current, document: { ...current.document, contextReferences: [] } });
    stack = pushUndo(stack, renamed('前の段'), { now: 1_000 });
    stack = pushUndo(stack, current, { now: 2_000 });
    stack = pushUndo(stack, renamed('先の段'), { now: 3_000 });
    return undo(stack);
  }

  /** 画面の確定(contextReferenceCommand.ts)と同じく今の段から確定し、受けた時だけ 1 段積む。 */
  async function commitOnHistory(stack: UndoStack<Snapshot>, link: ContextReferenceLink) {
    const result = await commitContextReference(stack.present.document, stack.present.library, link, () => SOURCE_POINT);
    return { result, stack: 'code' in result ? stack
      : pushUndo(stack, { document: result.document, library: result.library }, { now: 4_000 }) };
  }

  /** 一式の Map と添付のバイト列を配列にした写し(JSON と深い比較で中身まで比べるため)。 */
  function plainLibrary(library: PartLibrary) {
    return {
      partFiles: library.partFiles, parts: [...library.parts],
      attachments: [...library.attachments].map(([ref, attachments]) => [ref,
        [...attachments.shapes].map(([name, bytes]) => [name, Array.from(bytes)]),
        [...attachments.meshes].map(([name, mesh]) => [name, Array.from(mesh.positions), Array.from(mesh.normals),
          Array.from(mesh.indices)]),
        [...attachments.canvases].map(([name, bytes]) => [name, Array.from(bytes)])]),
      assemblies: [...(library.assemblies ?? new Map<string, AssemblyDocument>())],
    };
  }

  function plainHistory(stack: UndoStack<Snapshot>) {
    const plain = (snapshot: Snapshot) => ({ document: snapshot.document, library: plainLibrary(snapshot.library) });
    return { past: stack.past.map(plain), present: plain(stack.present), future: stack.future.map(plain),
      coalesceKey: stack.coalesceKey, coalesceAt: stack.coalesceAt };
  }

  async function sha256Of(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  it.each<readonly [string, readonly string[], readonly Pair[], Pair]>([
    ['2 辺の循環(A←B があり B←A を足す)', ['A', 'B'], [[0, 1]], [1, 0]],
    ['3 辺の循環(A←B←C があり C←A を足す)', ['A', 'B', 'C'], [[0, 1], [1, 2]], [2, 0]],
    ['共有 partRef の循環(A←B があり、B の点を A の別の配置から決める)', ['A', 'B', 'A'], [[0, 1]], [1, 2]],
    ['1,000 配置の一本道を閉じる循環', THOUSAND, chain(999), [999, 0]],
  ])('%s は cyclicReference で断り、文書・一式・Undo の履歴が SHA-256 と深い比較で変わらない', async (_case, labels, existing, added) => {
    const { snapshot, linkOf } = await sceneOf(labels, existing);
    const stack = historyAt(snapshot);
    // 履歴の山が空でないことを先に確かめる(前に 2 段・先に 1 段、今の段がこの組立)。
    expect([stack.past.length, stack.future.length, stack.present === snapshot]).toEqual([2, 1, true]);
    const links = snapshot.document.contextReferences ?? [];
    const { parts, partFiles, attachments } = snapshot.library;
    const sha = await sha256Of(plainHistory(stack));
    const frozen = structuredClone(plainHistory(stack));
    const link = linkOf(added, existing.length);
    const committed = await commitOnHistory(stack, link);
    expect(committed.result).toEqual({ code: 'cyclicReference', linkId: link.id });
    expect(committed.stack).toBe(stack);
    expect(await sha256Of(plainHistory(stack))).toBe(sha);
    expect(plainHistory(stack)).toEqual(frozen);
    expect(snapshot.document.contextReferences).toBe(links);
    expect([snapshot.library.parts, snapshot.library.partFiles, snapshot.library.attachments]).toEqual([parts, partFiles, attachments]);
    // 開く時の判定も同じ答え: 足す前は循環でなく、足すと循環。
    expect(contextReferencesHaveCycle(snapshot.document, links)).toBe(false);
    expect(contextReferencesHaveCycle(snapshot.document, [...links, link])).toBe(true);
  });

  it.each<readonly [string, readonly string[], readonly Pair[], Pair]>([
    ['2 辺の対照(A←B があり B←C を足す)', ['A', 'B', 'C'], [[0, 1]], [1, 2]],
    ['3 辺の対照(A←B←C があり C←D を足す)', ['A', 'B', 'C', 'D'], [[0, 1], [1, 2]], [2, 3]],
    ['共有 partRef の対照(A←B があり、C の点を B の別の配置から決める)', ['A', 'B', 'C', 'B'], [[0, 1]], [2, 3]],
    ['1,000 配置の一本道の最後の 1 本', THOUSAND, chain(998), [998, 999]],
  ])('%s は循環でないので受け、Undo の 1 段だけを積む。元の履歴は変わらない', async (_case, labels, existing, added) => {
    const { snapshot, ids, linkOf } = await sceneOf(labels, existing);
    const stack = historyAt(snapshot);
    const sha = await sha256Of(plainHistory(stack));
    const links = snapshot.document.contextReferences ?? [];
    const link = linkOf(added, existing.length);
    expect(contextReferencesHaveCycle(snapshot.document, [...links, link])).toBe(false);
    const committed = await commitOnHistory(stack, link);
    if ('code' in committed.result) throw new Error(JSON.stringify(committed.result));
    // 受けた確定は 1 段: 前の段は今の段を 1 つ足しただけで、先の段は消える。1 回の Undo で元の段へ戻る。
    const expectedPast = [...stack.past, snapshot];
    expect(committed.stack.past).toHaveLength(expectedPast.length);
    committed.stack.past.forEach((entry, index) => { expect(entry).toBe(expectedPast[index]); });
    expect(committed.stack.future).toEqual([]);
    expect(undo(committed.stack).present).toBe(snapshot);
    // 結び付けは 1 本増え、配置は同じ。書いたのは先の部品の基準点だけ(既定の配置なので元の面の中心と同じ点)。
    expect(committed.stack.present.document.contextReferences).toEqual([...links, link]);
    expect(committed.stack.present.document.components).toBe(snapshot.document.components);
    const target = snapshot.document.components.find((component) => component.id === ids[added[0]])?.source;
    if (target?.kind !== 'part') throw new Error('target');
    const written = committed.stack.present.library.parts.get(target.partRef);
    if (written === undefined) throw new Error('part');
    expectClose(coordinateOf(written), SOURCE_POINT);
    expectClose(committed.result.point, SOURCE_POINT);
    for (const [ref, part] of snapshot.library.parts) {
      if (ref !== target.partRef) expect(committed.stack.present.library.parts.get(ref)).toBe(part);
    }
    // 受けた時も、渡した履歴(文書・一式)はその場で書き換えない。
    expect(await sha256Of(plainHistory(stack))).toBe(sha);
  });
});
