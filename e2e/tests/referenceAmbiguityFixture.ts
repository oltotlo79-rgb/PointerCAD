import * as Comlink from 'comlink';
import { createShapeCache, type CachedSolid as NativePreviewCachedSolid } from '../../packages/kernel/src/index.js';
/**
 * R01/R17 共通の画面検査用fixture。曖昧・消失した部分形状参照を持つ文書を、実OCCTで計算した形から組む。
 *
 * 形は「土台100×40の上に、幅10と幅40の2本の腕が立つU字」の押し出し(奥行300)。
 * 腕の上の辺は長さ10と40、上の面は幅10と幅40で、向きは同じ。保存した参照を
 * 「長さ(面積)20(4000)・2本の中間の位置」にすると、2本の点が閾値を超えて差が0.05未満になる
 * (レビュー F01 の 10mm/40mm の反例を実形状で作った形)。参照の通し番号は存在しない 999 にして、
 * 番号の一致で点が加わらないようにする。`mirror` は形を左右反転し、候補の番号の並びを入れ替える。
 *
 * 作った参照は、画面と同じ共通の解決 `resolveSubShapeReference` で
 * 曖昧(ambiguous)・消失(missing)・一意(matched)になることをその場で確かめ、外れたら例外にする。
 * 後続の R17(参照の修復)の画面検査も、この `buildReferenceAmbiguityScenario` と文書の作り手を呼んで使う。
 */
import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { writeDocumentBundle, writePcaddFile, writePcadFile } from '../../packages/io/src/index.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import {
  absoluteCoordinate, addComponent, appendFeature, appendSolid, appearanceFromPreset, assignAppearance,
  createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor, createDirectKernelBridge, createKernelBridge,
  createDrawingDocument, createEmptyPartDocument, createPointFeature, createPrimitiveFeature,
  DEFAULT_FACE_COLOR, DEFAULT_WORK_PLANE_ID, FREE_WORK_PLANE_ID as NATIVE_PREVIEW_FREE_PLANE,
  DEFAULT_COMPONENT_PLACEMENT as DEFAULT_COMPONENT_PLACEMENT_NATIVE, drawingSourceInputHash, embedPart, EMPTY_PART_LIBRARY,
  createSubShapeReference, recomputePart, resolveSubShapeReference,
  type AssemblyDocument, type DrawingDocument, type Mate, type PartDocument, type SketchDocument,
  type SketchFaceFeature, type SketchLineFeature as NativePreviewSketchLine, type SolidBody, type SolidEdgeEntry, type SolidFaceEntry, type SubShapeRef,
} from '../../packages/model/src/index.js';

const SAVED_AT = '2026-10-05T00:00:00.000Z';
export const AMBIGUITY_BODY_ID = 'u-body';
export const AMBIGUITY_HOLE_NAME = '穴1';
const DEPTH = 300;
const near = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) <= tolerance;

export interface ReferenceAmbiguityRefs {
  readonly bodyId: string;
  /** 長さ10の辺と長さ40の辺が同点になる直線の参照。 */
  readonly ambiguousEdge: SubShapeRef;
  readonly missingEdge: SubShapeRef;
  /** 実在する辺そのもの(通し番号・位置が一致する一意の例)。長さ100。 */
  readonly uniqueEdge: SubShapeRef;
  /** 幅10の腕の上の面と幅40の腕の上の面が同点になる平面の参照。 */
  readonly ambiguousFace: SubShapeRef;
  readonly missingFace: SubShapeRef;
  /** 土台の下の面(一意)。 */
  readonly uniqueFace: SubShapeRef;
  /** 曖昧の候補になる2辺の長さ。画面に正常値として出てはならない値。 */
  readonly candidateLengths: readonly [10, 40];
  readonly uniqueEdgeLength: 100;
}

export interface ReferenceAmbiguityScenario {
  readonly mirror: boolean;
  readonly part: PartDocument;
  readonly body: SolidBody;
  readonly refs: ReferenceAmbiguityRefs;
}

function profilePoints(mirror: boolean): readonly (readonly [number, number])[] {
  const base: readonly (readonly [number, number])[] = [[0, 0], [100, 0], [100, 40], [60, 40], [60, 10], [10, 10], [10, 40], [0, 40]];
  return mirror ? base.map(([x, y]): readonly [number, number] => [100 - x, y]).reverse() : base;
}

function uPart(name: string, mirror: boolean): PartDocument {
  let part: PartDocument = { ...createEmptyPartDocument(), name };
  let sketch: SketchDocument = { id: 'u-sketch', name: 'U字の断面', features: [] };
  const boundary: { featureId: string }[] = [];
  for (const [x, y] of profilePoints(mirror)) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, 0));
    sketch = appendFeature(sketch, point);
    boundary.push({ featureId: point.id });
  }
  const face: SketchFaceFeature = { id: 'u-face', name: 'U字', kind: 'face', planeId: DEFAULT_WORK_PLANE_ID, boundary, color: DEFAULT_FACE_COLOR };
  part = { ...part, sketches: [...part.sketches, appendFeature(sketch, face)] };
  return appendSolid(part, { id: AMBIGUITY_BODY_ID, name: 'U字の柱', kind: 'extrude', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: face.id }, distance: number(DEPTH), reversed: false, symmetric: false });
}

function only<T>(items: readonly T[], label: string): T {
  if (items.length !== 1) throw new Error(`${label}: 候補が${String(items.length)}件`);
  return items[0];
}

function edgeRef(index: number, value: { curveKind: 'line'; length: number; position: SolidEdgeEntry['midpoint']; axis: SolidEdgeEntry['axis'] }): SubShapeRef {
  return { bodyFeatureId: AMBIGUITY_BODY_ID, index, fingerprint: { kind: 'edge', curveKind: value.curveKind,
    length: value.length, position: value.position, axis: value.axis, radius: null } };
}

function faceRef(index: number, value: { area: number; position: SolidFaceEntry['centroid']; axis: SolidFaceEntry['axis'] }): SubShapeRef {
  return { bodyFeatureId: AMBIGUITY_BODY_ID, index, fingerprint: { kind: 'face', surfaceKind: 'plane',
    area: value.area, position: value.position, axis: value.axis, radius: null } };
}

function expectStatus(body: SolidBody, reference: SubShapeRef, status: 'matched' | 'missing' | 'ambiguous', label: string): void {
  const resolution = resolveSubShapeReference(body, reference);
  if (resolution.status !== status) {
    throw new Error(`${label}: 期待 ${status} / 実際 ${resolution.status}(候補${String(resolution.candidates.length)}件)`);
  }
}

/** 実OCCTでU字の形を計算し、曖昧・消失・一意の参照を作る。 */
export async function buildReferenceAmbiguityScenario(mirror = false): Promise<ReferenceAmbiguityScenario> {
  const part = uPart(mirror ? '曖昧参照の部品(反転)' : '曖昧参照の部品', mirror);
  const partId = `reference-ambiguity-${mirror ? 'mirror' : 'normal'}`, api = createKernelApi(loadOcctForNode);
  try {
    const result = await recomputePart(part, createDirectKernelBridge(api), { partId, generation: 1 });
    if (result.errors.length !== 0 || result.cancelled) throw new Error(`OCCT: ${JSON.stringify(result.errors)}`);
    const body = only(result.bodies.filter(item => item.featureId === AMBIGUITY_BODY_ID), 'U字の柱');
    const low = Math.min(...body.edges.map(edge => edge.midpoint[2]));
    const alongX = (edge: SolidEdgeEntry): boolean => edge.curveKind === 'line' && edge.axis !== null && near(Math.abs(edge.axis[0]), 1);
    const edgeAt = (length: number, y: number): SolidEdgeEntry => only(body.edges.filter(edge => alongX(edge)
      && near(edge.length, length) && near(edge.midpoint[1], y) && near(edge.midpoint[2], low)), `X方向の辺 長さ${String(length)} y=${String(y)}`);
    const short = edgeAt(10, 40), long = edgeAt(40, 40), unique = edgeAt(100, 0);
    if (short.axis === null || long.axis === null || short.axis[0] * long.axis[0] <= 0) {
      throw new Error(`長さ10と40の辺の向きが逆です: ${JSON.stringify([short.axis, long.axis])}`);
    }
    const middle = (a: readonly number[], b: readonly number[]): [number, number, number] =>
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const ambiguousEdge = edgeRef(999, { curveKind: 'line', length: 20, position: middle(short.midpoint, long.midpoint), axis: long.axis });
    const missingEdge = edgeRef(998, { curveKind: 'line', length: 5000, position: [10000, 10000, 10000], axis: long.axis });
    const uniqueEdge = edgeRef(unique.index, { curveKind: 'line', length: unique.length, position: unique.midpoint, axis: unique.axis });

    const topFace = (width: number): SolidFaceEntry => only(body.faces.filter(face => face.surfaceKind === 'plane'
      && face.axis !== null && near(face.axis[1], 1) && near(face.centroid[1], 40) && near(face.area, width * DEPTH)), `上の面 幅${String(width)}`);
    const small = topFace(10), large = topFace(40);
    const bottom = only(body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
      && near(face.axis[1], -1) && near(face.centroid[1], 0) && near(face.area, 100 * DEPTH)), '土台の下の面');
    const ambiguousFace = faceRef(999, { area: Math.sqrt(small.area * large.area), position: middle(small.centroid, large.centroid), axis: large.axis });
    const missingFace = faceRef(998, { area: 1e8, position: [10000, 10000, 10000], axis: large.axis });
    const uniqueFace = faceRef(bottom.index, { area: bottom.area, position: bottom.centroid, axis: bottom.axis });

    expectStatus(body, ambiguousEdge, 'ambiguous', '曖昧な辺');
    expectStatus(body, missingEdge, 'missing', '消失した辺');
    expectStatus(body, uniqueEdge, 'matched', '一意の辺');
    expectStatus(body, ambiguousFace, 'ambiguous', '曖昧な面');
    expectStatus(body, missingFace, 'missing', '消失した面');
    expectStatus(body, uniqueFace, 'matched', '一意の面');
    return { mirror, part, body, refs: { bodyId: AMBIGUITY_BODY_ID, ambiguousEdge, missingEdge, uniqueEdge, ambiguousFace,
      missingFace, uniqueFace, candidateLengths: [10, 40], uniqueEdgeLength: 100 } };
  } finally { await api.releasePart(partId); }
}

/* ------------------------------------------------------------------ 加工(穴) */

export interface AmbiguityPartFile {
  readonly bytes: Uint8Array;
  readonly document: PartDocument;
  /** Undo/Redoの検査で抑制を切り替える、参照と無関係な箱の名前。 */
  readonly spareName: string;
}

function withSpareBox(part: PartDocument): { readonly part: PartDocument; readonly spareName: string } {
  const spare = createPrimitiveFeature(part, 'box', { kind: 'coordinate', value: absoluteCoordinate(300, 0, 0) });
  return { part: appendSolid(part, spare), spareName: spare.name };
}

/** 穴の面が曖昧な部品。穴は面を1つに決められず失敗し、元の面参照は文書に残る。 */
export function ambiguousHolePart(scenario: ReferenceAmbiguityScenario): AmbiguityPartFile {
  let part = scenario.part;
  let sketch: SketchDocument = { id: 'hole-sketch', name: '穴の中心', features: [] };
  const center = createPointFeature(sketch, absoluteCoordinate(scenario.mirror ? 20 : 80, 20, 150));
  sketch = appendFeature(sketch, center);
  part = { ...part, sketches: [...part.sketches, sketch] };
  part = appendSolid(part, { id: 'hole-1', name: AMBIGUITY_HOLE_NAME, suppressed: false, kind: 'hole',
    targetFeatureId: AMBIGUITY_BODY_ID, face: scenario.refs.ambiguousFace, centers: [{ sketchId: sketch.id, pointFeatureId: center.id }],
    diameter: number(8), depth: { kind: 'through' }, tiltAngle: number(0), tiltAzimuth: number(0) });
  const spare = withSpareBox(part);
  return { bytes: writePcadFile(spare.part, { savedAt: SAVED_AT }), document: spare.part, spareName: spare.spareName };
}

/* ------------------------------------------------------------------ 外観 */

/** 面の外観が曖昧・消失・一意の3つの部品。 */
export function ambiguousAppearancePart(scenario: ReferenceAmbiguityScenario): AmbiguityPartFile {
  let table = scenario.part.appearance;
  for (const [ref, color] of [[scenario.refs.ambiguousFace, '#d62728'], [scenario.refs.missingFace, '#1f77b4'],
    [scenario.refs.uniqueFace, '#2ca02c']] as const) {
    table = assignAppearance(table, { kind: 'face', ref }, appearanceFromPreset('plastic', color));
  }
  const spare = withSpareBox({ ...scenario.part, appearance: table });
  return { bytes: writePcadFile(spare.part, { savedAt: SAVED_AT }), document: spare.part, spareName: spare.spareName };
}

/* ------------------------------------------------------------------ 合致 */

export interface AmbiguityAssemblyFile {
  readonly bytes: Uint8Array;
  readonly document: AssemblyDocument;
  readonly matedControlName: string;
  readonly ambiguousMateName: string;
  readonly missingMateName: string;
}

/** 部品2つ。原点どうしの合致(一意)と、曖昧な面・消失した面を使う合致2本。 */
export async function ambiguousMateAssembly(scenario: ReferenceAmbiguityScenario): Promise<AmbiguityAssemblyFile> {
  const embedded = await embedPart(EMPTY_PART_LIBRARY, scenario.part, 'u-part.pcad', '', { importedAt: SAVED_AT });
  const source = { kind: 'part' as const, partRef: embedded.partRef };
  const empty = createAssemblyDocument('曖昧な合致');
  let document = addComponent(empty, createComponentFor(empty, source, { partName: 'U字', placement: {
    position: [number(0), number(0), number(0)], rotation: [0, 0, 0, 1] } }));
  document = addComponent(document, createComponentFor(document, source, { partName: 'U字', placement: {
    position: [number(300), number(0), number(0)], rotation: [0, 0, 0, 1] } }));
  const [first, second] = document.components;
  if (first === undefined || second === undefined) throw new Error('2部品を作れませんでした。');
  const control: Mate = { id: 'mate-1', name: '原点の一致', kind: 'coincident',
    a: { kind: 'origin', componentId: first.id, element: 'origin' },
    b: { kind: 'origin', componentId: second.id, element: 'origin' }, flipped: false, suppressed: false };
  const subShapeMate = (id: string, name: string, ref: SubShapeRef): Mate => ({ id, name, kind: 'coincident',
    a: { kind: 'subShape', componentId: first.id, ref },
    b: { kind: 'origin', componentId: second.id, element: 'xy' }, flipped: false, suppressed: false });
  const ambiguous = subShapeMate('mate-2', '曖昧な面', scenario.refs.ambiguousFace);
  const missing = subShapeMate('mate-3', '消えた面', scenario.refs.missingFace);
  document = { ...document, mates: [control, ambiguous, missing] };
  return { bytes: await writeDocumentBundle(createAssemblyDocumentBundle(document, embedded.library), { savedAt: SAVED_AT }),
    document, matedControlName: control.name, ambiguousMateName: ambiguous.name, missingMateName: missing.name };
}

/* ------------------------------------------------------------------ 寸法 */

export interface AmbiguityDrawingFile {
  readonly bytes: Uint8Array;
  readonly document: DrawingDocument;
  readonly ambiguousId: string;
  readonly missingId: string;
  readonly controlId: string;
}

/** 寸法3本。曖昧な辺・消失した辺・一意の辺(長さ100)。 */
export async function ambiguousDimensionDrawing(scenario: ReferenceAmbiguityScenario): Promise<AmbiguityDrawingFile> {
  const part = scenario.part, sourceRef = 'source-1', source = { sourceKind: 'part' as const, document: part };
  let document = createDrawingDocument('曖昧な寸法', { sourceRef, sourceKind: 'part', path: '', fileName: 'u-part.pcad',
    contentHash: await drawingSourceInputHash(source), importedAt: SAVED_AT });
  document = { ...document, sheet: { ...document.sheet, paperSizeId: 'A2-landscape' }, views: [
    { id: 'front', name: '正面図', kind: 'front', position: [105, 300], direction: [0, 1, 0], xDir: [1, 0, 0], scale: 1,
      showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
  const dimension = (id: string, ref: SubShapeRef, at: number) => ({ id, kind: 'length' as const, measurement: 'trueDistance' as const,
    targets: [{ kind: 'subShape' as const, viewId: 'front', sourceRef, ref }], placement: { commonNormalCoordinate: at, textPosition: null },
    origin: 'manual' as const, reference: false, layerId: 'layer-4' });
  document = { ...document, dimensions: [dimension('dim-ambiguous', scenario.refs.ambiguousEdge, 240),
    dimension('dim-missing', scenario.refs.missingEdge, 255), dimension('dim-control', scenario.refs.uniqueEdge, 270)] };
  return { bytes: writePcaddFile(document, { source, savedAt: SAVED_AT }), document,
    ambiguousId: 'dim-ambiguous', missingId: 'dim-missing', controlId: 'dim-control' };
}


/** Independent expected saved face from real native topology, not UI text/index order. */
export function referenceRepairFaceChoice(scenario: ReferenceAmbiguityScenario): SubShapeRef {
  const face = only(scenario.body.faces.filter(item => item.surfaceKind === 'plane'
    && item.axis !== null && near(item.axis[1], 1) && near(item.centroid[1], 40)
    && near(item.area, 10 * DEPTH)), '修復する幅10の腕の面');
  const reference = createSubShapeReference(scenario.body, 'face', face.index);
  if (reference === null || reference.fingerprint.kind !== 'face') throw new Error('実形状から修復面の由来を取得できません。');
  expectStatus(scenario.body, reference, 'matched', '確定する面は保存後も一意');
  return reference;
}

/** Test-owned Node transport runs actual Comlink/native API; it is not an OS/browser Worker identity proof. */
function managedNativePreviewGenerator() {
  const cache = createShapeCache<NativePreviewCachedSolid>(
    undefined,
    ({ mesh }) => mesh.positions.byteLength + mesh.normals.byteLength
      + mesh.indices.byteLength + mesh.edgePositions.byteLength,
    ({ mesh }) => [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edgePositions.buffer],
  );
  const api = createKernelApi(loadOcctForNode, cache);
  const workers: { terminate(): void }[] = [];
  class NativePreviewTransport extends EventTarget {
    readonly requests = new EventTarget();
    readonly listeners = new Set<EventListenerOrEventListenerObject>();
    closed = false;
    constructor() {
      super();
      if (workers.length !== 0) throw new Error('Only one generator-owned transport allowed');
      workers.push(this);
      const endpoint: Comlink.Endpoint = {
        postMessage: (message: unknown, transfer: Transferable[] = []) => {
          const data: unknown = structuredClone(message, { transfer });
          queueMicrotask(() => { if (!this.closed) this.dispatchEvent(new MessageEvent('message', { data })); });
        },
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
          this.listeners.add(listener); this.requests.addEventListener(type, listener);
        },
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
          this.listeners.delete(listener); this.requests.removeEventListener(type, listener);
        },
      };
      Comlink.expose(api, endpoint);
    }
    postMessage(message: unknown, transfer: Transferable[] = []): void {
      if (this.closed) throw new Error('Own generator transport closed');
      if (message !== null && typeof message === 'object' && 'kind' in message && message.kind === 'occt-module-bootstrap') {
        // Native API already uses the Node OCCT loader. Close this generator's
        // broker handoff port; broker port1 is returned by wrapped terminate.
        for (const item of transfer) { if (item instanceof MessagePort) item.close(); }
        return;
      }
      const data: unknown = structuredClone(message, { transfer });
      queueMicrotask(() => { if (!this.closed) this.requests.dispatchEvent(new MessageEvent('message', { data })); });
    }
    terminate(): void {
      if (this.closed) return;
      this.closed = true;
      for (const listener of this.listeners) this.requests.removeEventListener('message', listener);
      this.listeners.clear();
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  if (original !== undefined && original.configurable !== true) { cache.clear(); throw new Error('Node transport constructor cannot be owned'); }
  function close() {
    try { for (const worker of workers) worker.terminate(); }
    finally { cache.clear(); }
  }
  try {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: NativePreviewTransport });
    try {
      const bridge = createKernelBridge();
      return { api, bridge, close: () => { try { bridge.dispose(); } finally { close(); } } };
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'Worker');
      else Object.defineProperty(globalThis, 'Worker', original);
    }
  } catch (error) { close(); throw error; }
}

export interface NativeRepairPreviewFixture {
  readonly part: PartDocument;
  readonly partBytes: Uint8Array;
  readonly assemblyBytes: Uint8Array;
  readonly assembly: AssemblyDocument;
  readonly partSlotName: string;
  readonly mateName: string;
  readonly spareName: string;
  readonly choiceEdgeIndex: number;
  readonly assemblyChoiceEdgeIndex: number;
  /** Independent actual native local references; never derived from browser candidate UI. */
  readonly choiceRef: SubShapeRef;
  readonly assemblyChoiceRef: SubShapeRef;
  readonly nativeEvidence: {
    readonly generation: number;
    readonly partId: string;
    readonly hiddenFeatureId: string;
    readonly displayFeatureIds: readonly string[];
    readonly hiddenDispatchIds: readonly string[];
    readonly localOrigin: readonly number[];
    readonly sourceBackingBytes: number;
    readonly coverage: 'node-generator-actual-occt-hidden-source';
    readonly assemblySource: {
      readonly generation: number; readonly partId: string; readonly hiddenDispatchIds: readonly string[];
      readonly displayFeatureIds: readonly string[]; readonly localOrigin: readonly number[];
      readonly sourceBackingBytes: number;
    };
  };
}

/** This generator owns its managed bridge, actual native API and cloned Node transport. Node arrays are not browser Worker identities. */
export async function nativeRepairPreviewFixture(): Promise<NativeRepairPreviewFixture> {
  const scenario = await buildReferenceAmbiguityScenario();
  const tool = createPrimitiveFeature(scenario.part, 'box', { kind: 'coordinate', value: absoluteCoordinate(5, 5, 5) });
  let part = appendSolid(scenario.part, { ...tool, shape: { kind: 'box', sizeX: number(2), sizeY: number(2), sizeZ: number(2) } });
  part = appendSolid(part, { kind: 'boolean', id: 'preview-union', name: '元形状を消費する結合', suppressed: false,
    operation: 'union', targetFeatureId: AMBIGUITY_BODY_ID, toolFeatureId: tool.id });
  const zero = number(0), slotName = '非表示元形状の参照';
  const line: NativePreviewSketchLine = { id: 'hidden-source-line', name: slotName, kind: 'line', construction: false,
    planeId: NATIVE_PREVIEW_FREE_PLANE,
    from: { mode: 'relative', base: { kind: 'subShape', ref: scenario.refs.ambiguousEdge }, dx: zero, dy: zero, dz: zero },
    to: absoluteCoordinate(0, 0, 450) };
  // The independent sketch does not feed the U extrusion, so this is not a fabricated self-cycle.
  part = { ...part, sketches: [...part.sketches, { id: 'hidden-source-sketch', name: '非表示参照', features: [line] }] };
  const spare = withSpareBox(part); part = spare.part;
  const partId = 'r17-native-hidden-preview-generator', generation = 7;
  const managed = managedNativePreviewGenerator(), { api, bridge } = managed;
  let result: Awaited<ReturnType<typeof recomputePart>> | undefined;
  let assemblyResult: Awaited<ReturnType<typeof recomputePart>> | undefined;
  const assemblyPartId = `${partId}-assembly`, assemblyGeneration = generation + 1;
  let fixture: NativeRepairPreviewFixture | undefined;
  const failures: unknown[] = [];
  try {
    result = await recomputePart(part, bridge, { partId, generation,
      localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
    if (result.cancelled || result.generation !== generation) throw new Error('Actual generator generation required');
    if (result.bodies.some(body => body.featureId === AMBIGUITY_BODY_ID)) throw new Error('Consumed Source must be absent from actual final display');
    if (!result.bodies.some(body => body.featureId === 'preview-union')) throw new Error('Actual Boolean final display required');
    const hidden = only((result.referenceBodies ?? []).filter(body => body.featureId === AMBIGUITY_BODY_ID), '実非表示元形状');
    const scope = result.referenceMeshScope;
    if (scope === undefined || !scope.current || scope.document !== part || scope.context.partId !== partId
      || scope.context.generation !== generation || scope.referenceBodyCurrent(hidden) !== true) throw new Error('Actual issued hidden Source body/layout required');
    const owners = scope.owners.filter(owner => owner.kind === 'hidden' && owner.partId === partId && owner.generation === generation
      && owner.steps.some(step => step.id === AMBIGUITY_BODY_ID));
    if (owners.length === 0) throw new Error('Actual native hidden lease owner required');
    if (hidden.coordinateFrame?.space !== 'local' || !hidden.coordinateFrame.origin.every(Number.isFinite)
      || hidden.mesh.positions.byteLength === 0 || hidden.mesh.edgePositions.byteLength === 0) throw new Error('Actual local nonempty Source backing required');
    expectStatus(hidden, scenario.refs.ambiguousEdge, 'ambiguous', '現在の実非表示元形状の曖昧な辺');
    const low = Math.min(...hidden.edges.map(edge => edge.midpoint[2]));
    const choice = only(hidden.edges.filter(edge => edge.curveKind === 'line' && edge.axis !== null
      && near(Math.abs(edge.axis[0]), 1) && near(edge.length, 10) && near(edge.midpoint[1], 40)
      && near(edge.midpoint[2], low)), '実現在Sourceの10mm候補');
    const sourceBuffers = new Set([hidden.mesh.positions.buffer, hidden.mesh.normals.buffer, hidden.mesh.indices.buffer, hidden.mesh.edgePositions.buffer]);
    for (const buffer of sourceBuffers) {
      if (!(buffer instanceof ArrayBuffer)) throw new Error('Actual ArrayBuffer Source required');
      new Uint8Array(buffer); // Detached backing must reject instead of becoming zero evidence.
    }
    // Assembly caches only error-free Source results. Demand the same actual hidden
    // upstream body through a matched internal reference; only the external mate is ambiguous.
    const assemblyLine: NativePreviewSketchLine = { ...line,
      from: { mode: 'relative', base: { kind: 'subShape', ref: scenario.refs.uniqueEdge }, dx: zero, dy: zero, dz: zero } };
    const assemblySourcePart: PartDocument = { ...part, sketches: part.sketches.map(sketch => sketch.id === 'hidden-source-sketch'
      ? { ...sketch, features: sketch.features.map(feature => feature.id === line.id ? assemblyLine : feature) } : sketch) };
    assemblyResult = await recomputePart(assemblySourcePart, bridge, { partId: assemblyPartId, generation: assemblyGeneration,
      localMesh: { maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 } });
    if (assemblyResult.cancelled || assemblyResult.generation !== assemblyGeneration || assemblyResult.errors.length !== 0
      || assemblyResult.bodies.some(body => body.featureId === AMBIGUITY_BODY_ID)
      || !assemblyResult.bodies.some(body => body.featureId === 'preview-union')) throw new Error('Actual error-free Assembly Source final display required');
    const assemblyHidden = only((assemblyResult.referenceBodies ?? []).filter(body => body.featureId === AMBIGUITY_BODY_ID), '実Assembly非表示元形状');
    const assemblyScope = assemblyResult.referenceMeshScope;
    if (assemblyScope === undefined || !assemblyScope.current || assemblyScope.document !== assemblySourcePart
      || assemblyScope.context.partId !== assemblyPartId || assemblyScope.context.generation !== assemblyGeneration
      || !assemblyScope.referenceBodyCurrent(assemblyHidden)) throw new Error('Actual separate Assembly Source hidden owner required');
    const assemblyOwners = assemblyScope.owners.filter(owner => owner.kind === 'hidden' && owner.partId === assemblyPartId
      && owner.generation === assemblyGeneration && owner.steps.some(step => step.id === AMBIGUITY_BODY_ID));
    if (assemblyOwners.length === 0 || assemblyHidden.coordinateFrame?.space !== 'local'
      || !assemblyHidden.coordinateFrame.origin.every(Number.isFinite) || assemblyHidden.mesh.positions.byteLength === 0
      || assemblyHidden.mesh.edgePositions.byteLength === 0) throw new Error('Actual Assembly local Source backing required');
    expectStatus(assemblyHidden, scenario.refs.ambiguousEdge, 'ambiguous', '実Assembly Sourceの外部合致曖昧参照');
    const assemblyLow = Math.min(...assemblyHidden.edges.map(edge => edge.midpoint[2]));
    const assemblyChoice = only(assemblyHidden.edges.filter(edge => edge.curveKind === 'line' && edge.axis !== null
      && near(Math.abs(edge.axis[0]), 1) && near(edge.length, 10) && near(edge.midpoint[1], 40)
      && near(edge.midpoint[2], assemblyLow)), '実Assembly Sourceの10mm候補');
    const assemblyBuffers = new Set([assemblyHidden.mesh.positions.buffer, assemblyHidden.mesh.normals.buffer,
      assemblyHidden.mesh.indices.buffer, assemblyHidden.mesh.edgePositions.buffer]);
    for (const buffer of assemblyBuffers) { if (!(buffer instanceof ArrayBuffer)) throw new Error('Actual Assembly ArrayBuffer required'); new Uint8Array(buffer); }
    const nativeEvidence = { generation, partId, hiddenFeatureId: hidden.featureId,
      displayFeatureIds: result.bodies.map(body => body.featureId), hiddenDispatchIds: owners.map(owner => owner.dispatchId),
      localOrigin: [...hidden.coordinateFrame.origin], sourceBackingBytes: [...sourceBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      coverage: 'node-generator-actual-occt-hidden-source' as const,
      assemblySource: { generation: assemblyGeneration, partId: assemblyPartId, hiddenDispatchIds: assemblyOwners.map(owner => owner.dispatchId),
        displayFeatureIds: assemblyResult.bodies.map(body => body.featureId), localOrigin: [...assemblyHidden.coordinateFrame.origin],
        sourceBackingBytes: [...assemblyBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) } };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, assemblySourcePart, 'hidden-upstream.pcad', '', { importedAt: SAVED_AT });
    const source = { kind: 'part' as const, partRef: embedded.partRef }, empty = createAssemblyDocument('非表示元形状の修復');
    let assembly = addComponent(empty, createComponentFor(empty, source, { partName: '非表示の修復対象', placement: DEFAULT_COMPONENT_PLACEMENT_NATIVE }));
    assembly = addComponent(assembly, createComponentFor(assembly, source, { partName: '独立した通常表示', placement: DEFAULT_COMPONENT_PLACEMENT_NATIVE }));
    const [first, second] = assembly.components;
    if (first === undefined || second === undefined) throw new Error('Two actual embedded component owners required');
    const mateName = '非表示元形状の合致';
    const mate: Mate = { id: 'hidden-source-mate', name: mateName, kind: 'parallel', suppressed: false, flipped: false,
      a: { kind: 'subShape', componentId: first.id, ref: scenario.refs.ambiguousEdge },
      b: { kind: 'origin', componentId: second.id, element: 'x' } };
    assembly = { ...assembly, components: assembly.components.map(component => component.id === first.id ? { ...component, visible: false } : component), mates: [mate] };
    fixture = { part, partBytes: writePcadFile(part, { savedAt: SAVED_AT }), assembly,
      assemblyBytes: await writeDocumentBundle(createAssemblyDocumentBundle(assembly, embedded.library), { savedAt: SAVED_AT }),
      partSlotName: slotName, mateName, spareName: spare.spareName, choiceEdgeIndex: choice.index,
      assemblyChoiceEdgeIndex: assemblyChoice.index,
      choiceRef: edgeRef(choice.index, { curveKind: 'line', length: choice.length, position: choice.midpoint, axis: choice.axis }),
      assemblyChoiceRef: edgeRef(assemblyChoice.index, { curveKind: 'line', length: assemblyChoice.length, position: assemblyChoice.midpoint, axis: assemblyChoice.axis }),
      nativeEvidence };
  } catch (error: unknown) {
    failures.push(error);
  } finally {
    try {
      if (result?.referenceMeshScope !== undefined && !await result.referenceMeshScope.close()) {
        failures.push(new Error('Generator actual hidden cleanup failed'));
      }
    } catch (error: unknown) { failures.push(error); }
    try {
      if (assemblyResult?.referenceMeshScope !== undefined && !await assemblyResult.referenceMeshScope.close()) {
        failures.push(new Error('Generator actual Assembly hidden cleanup failed'));
      }
    } catch (error: unknown) { failures.push(error); }
    try { await api.releasePart(partId); } catch (error: unknown) { failures.push(error); }
    try { await api.releasePart(assemblyPartId); } catch (error: unknown) { failures.push(error); }
    try { managed.close(); } catch (error: unknown) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Native preview generator or cleanup failed');
  if (fixture === undefined) throw new Error('Native preview fixture unavailable after cleanup');
  return fixture;
}

/** Drawing adds a real Box whose maker issues semantic edge/face origins; old U/R01 stays intact. */
export async function referenceRepairDrawingFixture(scenario: ReferenceAmbiguityScenario) {
  const primitive = createPrimitiveFeature(scenario.part, 'box', { kind: 'coordinate', value: absoluteCoordinate(140, 20, 150) });
  const box = { ...primitive, shape: { kind: 'box' as const, sizeX: number(10), sizeY: number(2), sizeZ: number(300) } };
  if (box.kind !== 'primitive' || box.shape.kind !== 'box' || box.suppressed) throw new Error('Semantic Box source invalid');
  const part = appendSolid(scenario.part, box);
  const api = createKernelApi(loadOcctForNode), partId = 'r17-drawing-semantic-box';
  try {
    const result = await recomputePart(part, createDirectKernelBridge(api), { partId, generation: 1 });
    if (result.cancelled || result.errors.length !== 0) throw new Error(`OCCT Drawing: ${JSON.stringify(result.errors)}`);
    const body = only(result.bodies.filter(item => item.featureId === box.id), 'semantic Box body');
    if (!body.isValid || body.origins?.state !== 'tracked' || body.edges.length !== 12 || body.faces.length !== 6) {
      throw new Error('Actual Box maker did not issue complete native origins');
    }
    const low = Math.min(...body.edges.map(edge => edge.midpoint[2]));
    const edge = only(body.edges.filter(item => item.curveKind === 'line' && item.axis !== null
      && near(Math.abs(item.axis[0]), 1) && near(item.length, 10) && near(item.midpoint[1], 21)
      && near(item.midpoint[2], low)), 'semantic Box short front edge');
    const chosen = createSubShapeReference(body, 'edge', edge.index);
    if (chosen === null || chosen.fingerprint.kind !== 'edge' || chosen.origin?.identity.kind !== 'box-edge'
      || chosen.bodyFeatureId !== box.id || chosen.index !== edge.index) throw new Error('Actual native Box edge identity missing');
    expectStatus(body, chosen, 'matched', 'R17 semantic edge');
    const ambiguous: SubShapeRef = { bodyFeatureId: box.id, index: 999,
      fingerprint: { kind: 'edge', curveKind: 'line', length: 10, position: [140, 20, low], axis: null, radius: null } };
    expectStatus(body, ambiguous, 'ambiguous', 'R17 two real close parallel Box edges');
    const face = only(body.faces.filter(item => item.surfaceKind === 'plane' && item.axis !== null
      && near(item.axis[1], 1) && near(item.area, 3000)), 'semantic Box front face');
    const faceChosen = createSubShapeReference(body, 'face', face.index);
    if (faceChosen === null || faceChosen.fingerprint.kind !== 'face'
      || faceChosen.origin?.identity.kind !== 'box-face') throw new Error('Actual native Box face identity missing');
    expectStatus(body, faceChosen, 'matched', 'R17 semantic face');
    const ambiguousFace: SubShapeRef = { bodyFeatureId: box.id, index: 999,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 3000, position: [140, 20, 150], axis: null, radius: null } };
    expectStatus(body, ambiguousFace, 'ambiguous', 'R17 two real close parallel Box faces');
    const base = await ambiguousDimensionDrawing({ ...scenario, part });
    const datum = (id: string, label: string, ref: SubShapeRef) => ({ id, label,
      feature: { kind: 'surface' as const, target: { kind: 'subShape' as const, viewId: 'front',
        sourceRef: base.document.source.sourceRef, ref } }, position: [160, 200] as const, height: 5, layerId: 'layer-4' });
    const datumId = 'datum-semantic-face', ambiguousId = 'dim-semantic-ambiguous';
    const template = base.document.dimensions.find(item => item.id === base.ambiguousId);
    if (template?.kind !== 'length') throw new Error('Original Drawing length dimension missing');
    const document: DrawingDocument = { ...base.document,
      dimensions: [...base.document.dimensions, { ...template, id: ambiguousId,
        targets: template.targets.map(target => target.kind === 'subShape' ? { ...target, ref: ambiguous } : target) }],
      datums: [...base.document.datums, datum('datum-ambiguous-face', 'A', scenario.refs.ambiguousFace),
        datum(datumId, 'B', ambiguousFace)] };
    return { ...base, document, part, datumId, ambiguousId, chosen, faceChosen,
      bytes: writePcaddFile(document, { source: { sourceKind: 'part', document: part }, savedAt: SAVED_AT }) };
  } finally { await api.releasePart(partId); }
}
