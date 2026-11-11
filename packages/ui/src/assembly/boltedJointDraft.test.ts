import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, appendSolid, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  createSubShapeReference, emptyEmbeddedPartAttachments, partKeyOf, resolveAssembly, threadMinorDiameter,
  type AssemblyDocument, type CurrentOriginIndex, type HoleFeature, type MateTarget, type OriginBinding,
  type HoleFaceOrigin, type PartDocument, type PartLibrary, type SolidBody, type SolidFaceEntry, type SubShapeRef,
  type ThreadHoleFeature, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { AssemblyView } from '../store/assemblySlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  appendBoltedJointPick, commitBoltedJointDraft, createBoltedJointDraft, previewBoltedJointDraft, type AssemblyBoltedJointDraft,
  type BoltedJointThreadGroupTarget,
} from './boltedJointDraft.js';

const value = expressionValueFromNumber;
const DRILL = threadMinorDiameter(8, 1.25);

/** UI境界用の形の表。nativeからこの表までの道はmodel/kernelの別試験で確認する。 */
function wall(featureId: string, index: number): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: {
    kind: 'hole-face', featureId, center: { sketchId: 'centers', producer: { kind: 'point', featureId: `${featureId}-center` } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall',
  } } };
}

function cylinder(index: number, x: number, z: number, radius: number, length: number): SolidFaceEntry {
  return { index, surfaceKind: 'cylinder', area: 2 * Math.PI * radius * length, centroid: [x, 0, z],
    axis: [0, 0, 1], axisOrigin: [x, 0, z], cylinderSpan: [-length / 2, length / 2], cylinderExterior: false,
    radius, triangleOffset: 0, triangleCount: 0 };
}

function body(featureId: string, faces: readonly SolidFaceEntry[], bindings: readonly OriginBinding[]): SolidBody {
  return { featureId, bodyKind: 'solid', volume: 1000, isValid: true, faces: [...faces, {
    index: 2, surfaceKind: 'plane', area: 1000, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null,
    triangleOffset: 0, triangleCount: 0,
  }], edges: [], vertices: [], threadMarks: [], mesh: { positions: new Float32Array(0), normals: new Float32Array(0),
    indices: new Uint32Array(0), edgePositions: new Float32Array(0), triangleCount: 0 },
  origins: { version: 1, state: 'tracked', bindings: [...bindings, { state: 'unique', current: { kind: 'face', index: 2 },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'plate', role: 'top' } } }] } };
}

function reference(current: SolidBody, index: number): SubShapeRef {
  const found = createSubShapeReference(current, 'face', index);
  if (found === null) throw new Error(`Missing test face ${index}`);
  return found;
}

function fixtures(reverse = false, thickness = 28) {
  const first = body('final-a', [cylinder(1, 20, -thickness / 2, 4.5, thickness), cylinder(3, 40, -thickness / 2, 4.5, thickness)],
    [wall('hole-left', 1), wall('hole-right', 3)]);
  const second = body('final-b', [cylinder(1, 0, 10, DRILL / 2, 20)], [wall('thread-b', 1)]);
  const holes = ['hole-left', 'hole-right'].map((id): HoleFeature => ({ id, name: id, suppressed: false, kind: 'hole',
    targetFeatureId: 'plate', face: reference(first, 2), centers: [{ sketchId: 'centers', pointFeatureId: `${id}-center` }],
    diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) }));
  const partA = (reverse ? [...holes].reverse() : holes).reduce<PartDocument>(appendSolid, createEmptyPartDocument());
  const thread: ThreadHoleFeature = { id: 'thread-b', name: 'M8', suppressed: false, kind: 'threadHole',
    targetFeatureId: 'plate', face: reference(second, 2), centers: [{ sketchId: 'centers', pointFeatureId: 'thread-b-center' }],
    designation: 'M8', series: 'coarse', pitch: value(1.25), drillDiameter: value(DRILL), depth: { kind: 'blind', depth: value(20) },
    threadLength: value(16), representation: 'simplified', tiltAngle: value(0), tiltAzimuth: value(0) };
  const parts = new Map([['plate-a', partA], ['plate-b', appendSolid(createEmptyPartDocument(), thread)]]);
  const library: PartLibrary = { parts, attachments: new Map([...parts.keys()].map(ref => [ref, emptyEmbeddedPartAttachments()])),
    partFiles: [...parts.keys()].map(ref => ({ ref, fileName: `${ref}.pcad`, path: `${ref}.pcad`, contentHash: `revision-${ref}`,
      attachmentsDigest: 'empty', importedAt: '2026-10-01T00:00:00Z' })) };
  let document = createAssemblyDocument('同径穴の締結');
  for (const partRef of parts.keys()) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }));
  const keyA = partKeyOf({ kind: 'part', partRef: 'plate-a' });
  const keyB = partKeyOf({ kind: 'part', partRef: 'plate-b' });
  // 幾何を作り直す試験ではなく、表示済みの形を選ぶUIの道を検査する。
  const view: AssemblyView = { sourceDocument: document, resolved: { ...resolveAssembly(document),
    partKeys: new Map([['component-1', keyA], ['component-2', keyB]]) },
  bodies: new Map([[keyA, [first]], [keyB, [second]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
  const pick = (componentId: string, current: SolidBody, index: number): MateTarget =>
    ({ kind: 'subShape', componentId, ref: reference(current, index) });
  const draft = (index: number): AssemblyBoltedJointDraft => ({ ...createBoltedJointDraft('assembly'),
    engagementSource: '12', bottomClearanceSource: '2',
    picks: [pick('component-1', first, index), pick('component-1', first, 2),
      pick('component-2', second, 1), pick('component-2', second, 2)] });
  return { document, library, first, second, view, draft, keyA };
}

function withOrigins(view: AssemblyView, key: string, current: SolidBody, origins: CurrentOriginIndex): AssemblyView {
  const bodies = new Map(view.bodies);
  bodies.set(key, [{ ...current, origins }]);
  return { ...view, bodies };
}

describe('画面で選んだ同径穴を今の壁の由来へ結び付ける', () => {
  it.each([false, true])('文書の穴の順序によらず、選んだ位置へM8を予告・確定する(reverse=%s)', reverse => {
    const { document, library, view, draft } = fixtures(reverse);
    const original = JSON.stringify(document);
    for (const [index, x] of [[1, 20], [3, 40]] as const) {
      const picked = draft(index);
      const preview = previewBoltedJointDraft(document, view, library, picked);
      if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
      const plan = preview.result.plan;
      // M8本体規格の実収録候補は40mmから。板28+ねじ込み12=40、上限28+16-2=42。
      expect([plan.nominal, plan.gripLength, plan.boltLength, plan.engagedLength]).toEqual(['M8', 28, 40, 12]);
      const bolt = plan.operations.find(operation => operation.role === 'bolt');
      expect(bolt?.placement.position[0].value).toBeCloseTo(x, 10);
      expect(bolt?.placement.position[1].value).toBeCloseTo(0, 10);
      const committed = commitBoltedJointDraft(document, view, library, picked, plan);
      if (!committed.ok) throw new Error(JSON.stringify(committed));
      expect(committed.document).not.toBe(document);
      expect(committed.document.components).toHaveLength(document.components.length + plan.operations.length);
      expect(JSON.stringify(document)).toBe(original);
    }
  });

  it.each(['untracked', 'unnamed', 'ambiguous'] as const)('形と径が同じでも由来が%sなら予告も確定も断る', state => {
    const { document, library, view, draft, first, keyA } = fixtures();
    const picked = draft(1);
    const preview = previewBoltedJointDraft(document, view, library, picked);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    const origins: CurrentOriginIndex = state === 'untracked' ? { version: 1, state: 'untracked', reason: 'limit' }
      : { version: 1, state: 'tracked', bindings: state === 'unnamed' ? []
        : [{ ...wall('hole-left', 1), state: 'split', candidates: [{ kind: 'face', index: 1 }, { kind: 'face', index: 3 }] }] };
    const changed = withOrigins(view, keyA, first, origins);
    const issue = { kind: 'holeFeatureUnknown', componentId: 'component-1' };
    expect(previewBoltedJointDraft(document, changed, library, picked)).toEqual({ kind: 'issue', issue });
    expect(commitBoltedJointDraft(document, changed, library, picked, preview.result.plan)).toEqual({ ok: false, issue });
    expect(document.components).toHaveLength(2);
  });

  it('予告後に面の由来が別の穴へ変われば、径や番地が同じでも確定しない', () => {
    const { document, library, view, draft, first, keyA } = fixtures();
    const picked = draft(1);
    const preview = previewBoltedJointDraft(document, view, library, picked);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    const changed = withOrigins(view, keyA, first, { version: 1, state: 'tracked', bindings: [wall('another-hole', 1)] });
    expect(commitBoltedJointDraft(document, changed, library, picked, preview.result.plan))
      .toEqual({ ok: false, issue: { kind: 'holeFeatureUnknown', componentId: 'component-1' } });
  });

  it('必要な長さに規格候補が無ければ、近い長さで代用せず理由を返す', () => {
    // 初稿の不適合条件を否定試験として残す。板10+ねじ込み12=22、上限10+16-2=24。
    const { document, library, view, draft } = fixtures(false, 10);
    const preview = previewBoltedJointDraft(document, view, library, draft(1));
    expect(preview).toEqual({ kind: 'plan', result: { ok: false, rejections: [{ code: 'noStandardLengthFits', detail: {
      boltRowKey: 'JIS-B-1180:2014:M8:P1.25:main', minimum: 22, maximum: 24, reason: 'noCandidate',
    } }] } });
    expect(document.components).toHaveLength(2);
  });

  it('表示の文書が古い時は形を使わず、選択不足は必要数を知らせる', () => {
    const { document, library, view, draft } = fixtures();
    const newer: AssemblyDocument = { ...document, name: '更新後' };
    expect(previewBoltedJointDraft(newer, view, library, draft(1))).toEqual({ kind: 'issue', issue: { kind: 'stale' } });
    expect(previewBoltedJointDraft(document, view, library, { ...draft(1), picks: draft(1).picks.slice(0, 3) }))
      .toEqual({ kind: 'issue', issue: { kind: 'needPicks', count: 3 } });
  });
});

describe('実らせんの組の選択は締結の穴の枠だけで受ける', () => {
  const group: BoltedJointThreadGroupTarget = { kind: 'modeledThreadGroup', componentId: 'component-1', group: {
    bodyFeatureId: 'thread', hitFaceIndex: 7, origin: { kind: 'hole-face', featureId: 'thread',
      center: { sketchId: 'sketch', producer: { kind: 'point', featureId: 'center' } }, placement: { kind: 'original' },
      stage: 'bore', role: 'wall' } } };
  const face: MateTarget = { kind: 'subShape', componentId: 'component-1', ref: { bodyFeatureId: 'thread', index: 1,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } };

  it('穴A・穴Bの枠では足し、合わせ面の枠と5つ目では断る(下書きは保存しない)', () => {
    const empty = createBoltedJointDraft('doc');
    const first = appendBoltedJointPick(empty, group);
    expect(first?.picks).toEqual([group]);
    if (first === null) throw new Error('first');
    expect(appendBoltedJointPick(first, group)).toBeNull();
    const second = appendBoltedJointPick(first, face);
    if (second === null) throw new Error('second');
    const third = appendBoltedJointPick(second, group);
    expect(third?.picks).toHaveLength(3);
    if (third === null) throw new Error('third');
    const full = appendBoltedJointPick(third, face);
    if (full === null) throw new Error('full');
    expect(appendBoltedJointPick(full, group)).toBeNull();
  });
});

describe('実らせんの組の選択を、予告のたびに今のボディへ結び直す', () => {
  const origin = { kind: 'hole-face', featureId: 'thread', center: { sketchId: 'sketch', producer: { kind: 'point', featureId: 'center' } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall' } as const;

  it('普通の(分かれていない)壁を組として選んでも結び直せず断り、元の部品が変われば stale で断る', () => {
    const { document, library, view, draft, second } = fixtures();
    const picks = draft(1).picks;
    const group: BoltedJointThreadGroupTarget = { kind: 'modeledThreadGroup', componentId: 'component-2',
      group: { bodyFeatureId: second.featureId, origin, hitFaceIndex: 1 } };
    const grouped: AssemblyBoltedJointDraft = { ...draft(1), picks: [picks[0], picks[1], group, picks[3]].flatMap((item) =>
      item === undefined ? [] : [item]) };
    expect(grouped.picks).toHaveLength(4);
    expect(previewBoltedJointDraft(document, view, library, grouped)).toEqual({ kind: 'issue',
      issue: { kind: 'holeFeatureUnknown', componentId: 'component-2' } });
    // 同じ内容でも別の文書(読み直し・編集の後)なら、表示の形は今の文書のものではない。
    const stale = { ...view, sourceDocument: { ...document } };
    expect(previewBoltedJointDraft(document, stale, library, grouped)).toEqual({ kind: 'issue', issue: { kind: 'stale' } });
  });
});

describe('実らせんの穴(分かれた壁と溝)を組の選択で予告・確定する(UI の実際の下書きと store)', () => {
  const grooveOf = (identity: HoleFaceOrigin) => ({ ...identity, stage: 'thread' as const, role: 'groove' as const });
  /** 普通の fixtures の plate-b と同じ寸法(半径 DRILL/2、z 0〜20、入口 z 0)の実らせんの形。表の並び = 番地。 */
  function modeled(): SolidBody {
    const bore = wall('thread-b', 1).origin;
    if (bore.shapeKind !== 'face' || bore.identity.kind !== 'hole-face' || bore.identity.stage !== 'bore') throw new Error('bore');
    const piece = (index: number, extent: readonly [number, number], adjacentFaces: readonly number[]): SolidFaceEntry => ({
      index, surfaceKind: 'cylinder', area: 10, centroid: [0, 0, 10], axis: [0, 0, 1], axisOrigin: [0, 0, 10],
      cylinderSpan: null, cylinderAxialExtent: extent, cylinderExterior: false, radius: DRILL / 2, triangleOffset: 0, triangleCount: 0,
      adjacentFaces });
    return { featureId: 'final-b', bodyKind: 'solid', volume: 1000, isValid: true, faces: [
      { index: 0, surfaceKind: 'plane', area: 1, centroid: [0, 0, 50], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 0,
        adjacentFaces: [] },
      piece(1, [-10, 1], [2, 3, 4]),
      { index: 2, surfaceKind: 'plane', area: 1000, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 0,
        adjacentFaces: [1, 4] },
      piece(3, [0, 10], [1, 4, 5]),
      { index: 4, surfaceKind: 'other', area: 1, centroid: [3, 0, 10], axis: null, radius: null, triangleOffset: 0, triangleCount: 0,
        adjacentFaces: [1, 2, 3] },
      { index: 5, surfaceKind: 'plane', area: 10, centroid: [0, 0, 20], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 0,
        adjacentFaces: [3] },
    ], edges: [], vertices: [], threadMarks: [], mesh: { positions: new Float32Array(0), normals: new Float32Array(0),
      indices: new Uint32Array(0), edgePositions: new Float32Array(0), triangleCount: 0 },
    origins: { version: 1, state: 'tracked', bindings: [
      { origin: bore, state: 'split', candidates: [{ kind: 'face', index: 1 }, { kind: 'face', index: 3 }] },
      { origin: { version: 1, shapeKind: 'face', identity: grooveOf(bore.identity) }, state: 'unique', current: { kind: 'face', index: 4 } },
      { state: 'unique', current: { kind: 'face', index: 2 },
        origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'plate', role: 'top' } } },
    ] } };
  }
  function setup() {
    const base = fixtures();
    const threaded = modeled();
    const view: AssemblyView = { ...base.view, bodies: new Map([...base.view.bodies].map(([key, bodies]) =>
      [key, key === base.keyA ? bodies : [threaded]])) };
    const plain = base.draft(1);
    const [holeA, faceA] = plain.picks;
    if (holeA === undefined || faceA === undefined) throw new Error('picks');
    const group: BoltedJointThreadGroupTarget = { kind: 'modeledThreadGroup', componentId: 'component-2',
      group: { bodyFeatureId: 'final-b', origin: { ...wallIdentity() }, hitFaceIndex: 1 } };
    const mating: MateTarget = { kind: 'subShape', componentId: 'component-2', ref: reference(threaded, 2) };
    const draft: AssemblyBoltedJointDraft = { ...plain, picks: [holeA, faceA, group, mating] };
    // 普通の計画の比較には、同じ setup の元の view(元の文書が同じ)を使う。fixtures() を作り直さない。
    return { ...base, threaded, view, draft, plain, plainView: base.view };
  }
  function wallIdentity(): HoleFaceOrigin {
    const bore = wall('thread-b', 1).origin;
    if (bore.shapeKind !== 'face' || bore.identity.kind !== 'hole-face' || bore.identity.stage !== 'bore') throw new Error('bore');
    return bore.identity;
  }

  it('同じ寸法の普通の穴と同じ計画を予告・確定し、元の文書は変えない', () => {
    const { document, library, view, draft, plain, plainView } = setup();
    const original = JSON.stringify(document);
    const expected = previewBoltedJointDraft(document, plainView, library, plain);
    const preview = previewBoltedJointDraft(document, view, library, draft);
    if (preview.kind !== 'plan' || !preview.result.ok || expected.kind !== 'plan' || !expected.result.ok) {
      throw new Error(JSON.stringify([preview, expected]));
    }
    expect(preview.result.plan).toEqual(expected.result.plan);
    const committed = commitBoltedJointDraft(document, view, library, draft, preview.result.plan);
    if (!committed.ok) throw new Error(JSON.stringify(committed));
    expect(committed.document.components).toHaveLength(document.components.length + preview.result.plan.operations.length);
    expect(JSON.stringify(document)).toBe(original);
  });

  it('予告の後に溝の隣が壊れた形へ変われば確定せず、文書は変えない', () => {
    const { document, library, view, draft, threaded, keyA } = setup();
    const preview = previewBoltedJointDraft(document, view, library, draft);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    const damaged: SolidBody = { ...threaded, faces: threaded.faces.map((face) => face.index === 4
      ? { index: 4, surfaceKind: 'other' as const, area: 1, centroid: [3, 0, 10] as Vec3, axis: null, radius: null,
        triangleOffset: 0, triangleCount: 0 } : face) };
    const changed: AssemblyView = { ...view, bodies: new Map([...view.bodies].map(([key, bodies]) =>
      [key, key === keyA ? bodies : [damaged]])) };
    const original = JSON.stringify(document);
    expect(commitBoltedJointDraft(document, changed, library, draft, preview.result.plan))
      .toEqual({ ok: false, issue: { kind: 'holeFeatureUnknown', componentId: 'component-2' } });
    expect(JSON.stringify(document)).toBe(original);
  });

  it('store: 組を含む4つの選択で確定し、1回の取り消しで元の文書へ戻る', () => {
    resetTestStore();
    const { document, library, view, draft } = setup();
    useAppStore.getState().openAssembly(document, library);
    useAppStore.setState({ assemblyView: { ...view, sourceDocument: useAppStore.getState().assembly ?? document }, isComputing: false });
    const opened = useAppStore.getState().assembly;
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    for (const target of draft.picks) expect(useAppStore.getState().pickBoltedJointFace(target)).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: draft.engagementSource,
      bottomClearanceSource: draft.bottomClearanceSource });
    expect(useAppStore.getState().assemblyBoltedJointPreview).toMatchObject({ kind: 'plan', result: { ok: true } });
    expect(useAppStore.getState().commitBoltedJoint()).toBe(true);
    expect(useAppStore.getState().assembly).not.toBe(opened);
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly).toEqual(opened);
  });
});
