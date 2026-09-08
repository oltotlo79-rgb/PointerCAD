import { addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument, EMPTY_PART_LIBRARY,
  resolveAssembly, resolvePart, type PartDocument, type SolidBody } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachAssemblyInteraction, mateTargetFromFaceHit, pickAssemblyMateTarget } from './attachAssemblyInteraction.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { commitMateDraft, editAssemblyMate, mateKindReadiness, startMate } from '../assembly/mateActions.js';
import { parseAssemblyTargetId } from '../assembly/mateCommands.js';

function body(): SolidBody {
  return {
    featureId: 'box',
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 },
    volume: 1,
    isValid: true,
    faces: [{ index: 3, surfaceKind: 'plane', area: 4, centroid: [1, 2, 3], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: 1 }],
    edges: [], vertices: [], threadMarks: [],
  };
}

describe('アセンブリ面pickから保存参照への変換', () => {
  it('instance idと部品内指紋を組にする', () => {
    expect(mateTargetFromFaceHit({ componentId: 'component-2', bodyFeatureId: 'box', faceIndex: 3 }, [body()]))
      .toMatchObject({ kind: 'subShape', componentId: 'component-2', ref: { bodyFeatureId: 'box', index: 3,
        fingerprint: { surfaceKind: 'plane', position: [1, 2, 3] } } });
  });

  it.each([
    { componentId: 'component-1', bodyFeatureId: 'missing', faceIndex: 3 },
    { componentId: 'component-1', bodyFeatureId: 'box', faceIndex: 2 },
    { componentId: 'component-1', bodyFeatureId: 'box', faceIndex: -1 },
  ])('存在しないbody/faceは対象を捏造しない', (hit) => {
    expect(mateTargetFromFaceHit(hit, [body()])).toBeNull();
  });

  it('入力bodyを変更しない', () => {
    const source = body();
    const before = structuredClone(source.faces);
    mateTargetFromFaceHit({ componentId: 'component-1', bodyFeatureId: 'box', faceIndex: 3 }, [source]);
    expect(source.faces).toEqual(before);
  });
});

beforeEach(resetTestStore);

function interactionFixture() {
  const part: PartDocument = { ...createEmptyPartDocument(), solids: [{ id: 'box', name: 'box', kind: 'importedSolid',
    suppressed: false, shapeRef: 'box-shape', bodyKind: 'solid',
    source: { format: 'step', fileName: 'box.step', unit: 'mm', byteLength: 1 } }] };
  const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['part', part]]) };
  let document = createAssemblyDocument('組立');
  for (let i = 0; i < 2; i += 1) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'part' }));
  useAppStore.getState().openAssembly(document, library);
  const resolved = resolveAssembly(document, { library, resolvedParts: new Map([['part', resolvePart(part,
    { importedShapes: new Map([['box-shape', Uint8Array.of(1)]]) })]]) });
  const view = { sourceDocument: document, resolved, bodies: new Map([['part', [body()]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
  useAppStore.setState({ assemblyView: view, isComputing: false, selectionKind: 'face' });
  // EventTargetで実listenerを駆動する。canvasの描画/WebGL/ブラウザは起動しない。
  const canvas = Object.assign(new EventTarget(), { focus: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  const scene = {
    pickAssemblyFace: vi.fn((x: number) => ({ componentId: x < 50 ? 'component-1' : 'component-2', partKey: 'part', bodyFeatureId: 'box', faceIndex: 3 })),
    pickComponent: vi.fn(() => 'component-1'), worldToScreen: (point: readonly [number, number, number]): readonly [number, number] => [point[0], point[1]],
  };
  const interaction = attachAssemblyInteraction(canvas, scene);
  const downstream = vi.fn();
  for (const kind of ['pointerdown', 'pointermove', 'keydown']) canvas.addEventListener(kind, downstream);
  const send = (type: string, properties: object = {}) => {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }),
      { button: 0, buttons: 0, altKey: false, clientX: 0, clientY: 0, isComposing: false }, properties);
    canvas.dispatchEvent(event); return event;
  };
  return { document, view, canvas, scene, interaction, downstream, send };
}

describe('assemblyの実listener', () => {
  it('円筒面は解析軸のある実対象へ解決し、同心候補として確定できる', () => {
    const f = interactionFixture();
    try {
      const cylinder: SolidBody = { ...body(), faces: [{ ...body().faces[0], surfaceKind: 'cylinder',
        radius: 5, axis: [0, 0, 1], axisOrigin: [0, 0, 0] }] };
      useAppStore.setState({ assemblyView: { ...f.view, bodies: new Map([['part', [cylinder]]]) } });
      f.send('pointerdown'); f.send('pointerdown', { clientX: 100 });
      expect(useAppStore.getState().assemblyMateDraft?.targetKinds).toEqual(['cylinder', 'cylinder']);
      expect(mateKindReadiness(useAppStore.getState(), 'concentric').ready).toBe(true);
      f.send('keydown', { key: 'Enter' });
      expect(useAppStore.getState().assembly?.mates[0].kind).toBe('concentric');
    } finally { f.interaction.detach(); }
  });

  it('編集した既存面が確定直前に消失したら文書・履歴を変更せず拒否する', () => {
    const f = interactionFixture();
    try {
      f.send('pointerdown'); f.send('pointerdown', { clientX: 100 }); f.send('keydown', { key: 'Enter' });
      const document = useAppStore.getState().assembly;
      if (document === null) throw new Error('fixture');
      useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: document } });
      editAssemblyMate('mate-1');
      expect(useAppStore.getState().assemblyMateDraft?.targetKinds).toEqual(['plane', 'plane']);
      useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: document, bodies: new Map() } });
      const before = useAppStore.getState();
      expect(commitMateDraft()).toMatchObject({ ok: false, reason: 'stale' });
      expect(useAppStore.getState().assembly).toBe(document);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(useAppStore.getState().assemblyMateDraft?.issue).not.toBeNull();
    } finally { f.interaction.detach(); }
  });
  it.each([false, true])('command先行=%sでも面2枚とcanvas Enterで1段だけ確定する', (commandFirst) => {
    const f = interactionFixture();
    try {
      if (commandFirst) startMate('coincident');
      f.send('pointerdown'); f.send('pointerdown', { clientX: 100 });
      expect(useAppStore.getState().assemblyMateDraft?.targets).toHaveLength(2);
      expect(f.canvas.focus).toHaveBeenCalledTimes(2);
      f.send('keydown', { key: 'Enter' });
      expect(useAppStore.getState().assembly?.mates).toHaveLength(1);
      expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
      expect(f.downstream).not.toHaveBeenCalled();
    } finally { f.interaction.detach(); }
  });

  it.each([{ altKey: true }, { altKey: true, shiftKey: true }, { button: 1 }, { button: 2 }])('視点・別ボタン操作%jを対象にしない', (properties) => {
    const f = interactionFixture();
    try {
      startMate('coincident'); f.send('pointerdown', properties);
      expect(f.scene.pickAssemblyFace).not.toHaveBeenCalled();
      expect(useAppStore.getState().assemblyMateDraft?.targets).toHaveLength(0);
    } finally { f.interaction.detach(); }
  });

  it('hoverはinstance付きID、Escapeは文書を変えず取消し、detachは全listenerを外す', () => {
    const f = interactionFixture();
    f.send('pointermove', { clientX: 100 });
    expect(parseAssemblyTargetId(useAppStore.getState().hoveredElementId ?? '')).toEqual({ componentId: 'component-2', elementId: 'box#face:3' });
    f.send('pointerdown'); f.send('keydown', { key: 'Escape' });
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyMateDraft).toBeNull();
    expect(useAppStore.getState().hoveredElementId).toBeNull();
    f.interaction.detach(); f.send('pointerdown'); f.send('pointermove'); f.send('keydown', { key: 'Enter' });
    expect(f.downstream).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().assemblyMateDraft).toBeNull();
  });

  it('part文書では後続へ渡し、assemblyの4は既存の部品選択を使う', () => {
    const f = interactionFixture();
    try {
      f.send('keydown', { key: '4' }); f.send('pointerdown');
      expect(useAppStore.getState().selection).toEqual(['component-1']);
      expect(useAppStore.getState().assemblyMateDraft).toBeNull();
      useAppStore.getState().closeAssembly();
      f.send('pointerdown');
      expect(f.downstream).toHaveBeenCalledTimes(1);
    } finally { f.interaction.detach(); }
  });

  it.each(['vertex', 'edge'] as const)('%sは配置を一度だけ適用して拾い、保存指紋は局所のまま', (kind) => {
    const f = interactionFixture();
    try {
      const source: SolidBody = { ...body(), vertices: [{ index: 0, position: [2, 3, 0] }],
        edges: [{ index: 0, curveKind: 'line', length: 10, midpoint: [5, 0, 0], start: [0, 0, 0], end: [10, 0, 0], axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 1 }],
        mesh: { ...body().mesh, edgePositions: new Float32Array([0, 0, 0, 10, 0, 0]) } };
      const view = { ...f.view, bodies: new Map([['part', [source]]]), resolved: { ...f.view.resolved,
        placements: new Map([['component-2', { position: [100, 20, 0] as const, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const }]]) } };
      const point: readonly [number, number] = kind === 'vertex' ? [97, 22] : [100, 29];
      const hit = pickAssemblyMateTarget(f.document, view, f.scene, point, kind);
      expect(hit).toMatchObject({ kind: 'subShape', componentId: 'component-2', ref: { fingerprint: { kind, position: kind === 'vertex' ? [2, 3, 0] : [5, 0, 0] } } });
    } finally { f.interaction.detach(); }
  });

  it.each(['hidden', 'suppressed', 'missingPart'] as const)('%sのface hitを拒否する', (condition) => {
    const f = interactionFixture();
    try {
      const document = { ...f.document, components: f.document.components.map((component) => condition === 'hidden' ? { ...component, visible: false }
        : condition === 'suppressed' ? { ...component, suppressed: true } : component) };
      const view = condition === 'missingPart' ? { ...f.view, bodies: new Map() } : f.view;
      expect(pickAssemblyMateTarget(document, view, f.scene, [0, 0], 'face')).toBeNull();
    } finally { f.interaction.detach(); }
  });
});
