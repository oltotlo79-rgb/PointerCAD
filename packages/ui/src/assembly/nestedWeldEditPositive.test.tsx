import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, buildStandardPartFromSource, createAssemblyDocument, createEmptyPartDocument, DEFAULT_COMPONENT_PLACEMENT, embedPart,
  EMPTY_PART_LIBRARY, partKeyOf, resolveAssembly, weldSegmentsOf,
  type AssemblyComponent, type AssemblyDocument, type PartLibrary, type PrimitiveFeature, type SolidBody,
} from '@pointercad/model';
import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BASE_BOX, STANDING_BOX, weldTestPlacement } from '../../../model/src/assembly/welding/filletWeld.testSupport.js';
import { t } from '../i18n/t.js';
import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { flattenAssemblyGeometry, type AssemblyOccurrencePath } from '../viewport/createAssemblyLayer.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import { FilletWeldPopover } from './FilletWeldPopover.js';

interface FormProps {
  readonly children?: React.ReactNode;
  readonly 'data-testid'?: string;
  readonly disabled?: boolean;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
}

/** 実際の溶接の窓を描き、欄と送信の処理をそのまま取り出す(予告・命令・確定は差し替えない)。 */
function renderedForm() {
  const fields = new Map<string, FormProps>();
  let onSubmit: FormProps['onSubmit'];
  const walk = (node: React.ReactNode): void => {
    if (!isValidElement<FormProps>(node)) return;
    if (node.props.onSubmit !== undefined) onSubmit = node.props.onSubmit;
    const id = node.props['data-testid'];
    if (id !== undefined) fields.set(id, node.props);
    React.Children.forEach(node.props.children, walk);
  };
  function Host(): React.JSX.Element | null {
    const tree = FilletWeldPopover();
    walk(tree);
    return tree;
  }
  const html = renderToStaticMarkup(<Host />);
  if (onSubmit === undefined) throw new Error('Weld form submit handler is missing');
  return { html, onSubmit, fields };
}

function typeInto(id: string, value: string): void {
  const onChange = renderedForm().fields.get(id)?.onChange;
  if (onChange === undefined) throw new Error(`Field is missing: ${id}`);
  onChange({ currentTarget: { value } });
}

function submitForm(): void {
  const preventDefault = vi.fn();
  renderedForm().onSubmit({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
}

/** 表示の当たりに使う線分を、ボディの解析的な直線の辺から作る(実際の形の辺と同じ位置)。 */
function withEdgeSegments(body: SolidBody): SolidBody {
  return { ...body, edges: body.edges.map((edge, index) => ({ ...edge, segmentOffset: index, segmentCount: 1 })),
    mesh: { ...body.mesh, edgePositions: new Float32Array(body.edges.flatMap((edge) => [...edge.start, ...edge.end])) } };
}

function boxPart(name: string, x: number, y: number, z: number) {
  const feature: PrimitiveFeature = { id: 'extrude-1', name, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: expressionValueFromNumber(x), sizeY: expressionValueFromNumber(y), sizeZ: expressionValueFromNumber(z) } };
  return appendSolid(createEmptyPartDocument(), feature);
}

const OWNER = `owner/${String.fromCharCode(0x7d44)},"B`;
const STANDING_PATH: AssemblyOccurrencePath = [OWNER, 'standing'];
const BASE_PATH: AssemblyOccurrencePath = ['base'];

/** 立板(子の組の葉)を根の底板に溶接する T 継手の組立と一式(本物の部品を抱き込み、子の組を一式に持つ)。 */
async function nestedTee() {
  const standingPart = boxPart('standing', 100, 8, 50), basePart = boxPart('base', 100, 60, 10);
  const standing = await embedPart(EMPTY_PART_LIBRARY, standingPart, 's.pcad', 's.pcad');
  const base = await embedPart(standing.library, basePart, 'b.pcad', 'b.pcad');
  const leaf = (id: string, partRef: string, placement: AssemblyComponent['placement']): AssemblyComponent => ({
    id, name: id, source: { kind: 'part', partRef }, placement, fixed: false, visible: true, suppressed: false });
  const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [leaf('standing', standing.partRef, weldTestPlacement([0, 26, 10]))] };
  const owner: AssemblyComponent = { id: OWNER, name: OWNER, source: { kind: 'subAssembly', assemblyRef: 'child' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false };
  const document: AssemblyDocument = { ...createAssemblyDocument('root'),
    components: [owner, leaf('base', base.partRef, DEFAULT_COMPONENT_PLACEMENT)] };
  const library: PartLibrary = { ...base.library, assemblies: new Map([['child', child]]) };
  return { document, library, child, standingPart, basePart };
}

/** 作り直しが終わった表示: 今の文書・一式を解き、解いた入力そのものと葉の形を表示に入れる。 */
function publishSolvedView(): void {
  const state = useAppStore.getState();
  const document = state.assembly;
  if (document === null) throw new Error('Assembly is missing');
  const source = jointOccurrenceInputsOf(document, state.assemblyLibrary);
  const resolved = resolveAssembly(document, { library: state.assemblyLibrary, subAssemblies: source.subAssemblies,
    standardPart: buildStandardPartFromSource });
  expect(resolved.errors).toEqual([]);
  const flat = flattenAssemblyGeometry(document, resolved);
  const keyOf = (path: readonly string[]): string => {
    const row = flat.components.find((component) => JSON.stringify(flat.occurrencePaths?.get(component.id)) === JSON.stringify(path));
    const key = row === undefined ? undefined : flat.partKeys.get(row.id);
    if (key === undefined) throw new Error(`Leaf part is missing: ${JSON.stringify(path)}`);
    return key;
  };
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: document, source, resolved,
    bodies: new Map([[keyOf(STANDING_PATH), [withEdgeSegments(STANDING_BOX)]], [keyOf(BASE_PATH), [withEdgeSegments(BASE_BOX)]]]),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
}

function realRef(body: SolidBody, kind: 'face' | 'edge', index: number) {
  const ref = subShapeRefOf([withEdgeSegments(body)], subShapeElementId('extrude-1', kind, index));
  if (ref === null) throw new Error(`Cannot create subshape reference: ${kind} ${String(index)}`);
  return ref;
}

/** 入れ子の溶接を今の窓で作る(立板の側面 3・下の辺 2、底板の上面 5。脚長 6×8、始点 10・長さ 20)。 */
function createNestedWeld(): AssemblyDocument {
  chooseAssemblyBuild('filletWeld');
  expect(useAppStore.getState().pickNestedFilletWeldTarget({ path: STANDING_PATH, ref: realRef(STANDING_BOX, 'face', 3) })).toBe(true);
  expect(useAppStore.getState().pickNestedFilletWeldTarget({ path: STANDING_PATH, ref: realRef(STANDING_BOX, 'edge', 2) })).toBe(true);
  expect(useAppStore.getState().pickNestedFilletWeldTarget({ path: BASE_PATH, ref: realRef(BASE_BOX, 'face', 5) })).toBe(true);
  typeInto('fillet-weld-leg-second', '6');
  typeInto('fillet-weld-leg-first', '8');
  typeInto('fillet-weld-start', '10');
  typeInto('fillet-weld-lengths', '20');
  typeInto('fillet-weld-material', 'aluminum');
  const created = useAppStore.getState().assemblyNestedWeldPreview;
  if (created?.kind !== 'plan' || !created.result.ok) throw new Error(`New weld preview was rejected: ${JSON.stringify(created)}`);
  // 6 × 8 / 2 × 20 = 480 mm³。
  expect(created.result.plan.nominalVolume).toBe(480);
  submitForm();
  const welded = useAppStore.getState().assembly;
  if (welded === null) throw new Error('Welded assembly is missing');
  return welded;
}

function selectWeldBead(document: AssemblyDocument): string {
  const bead = weldSegmentsOf(document).get('weld-1')?.[0]?.id;
  if (bead === undefined) throw new Error('Weld bead is missing');
  useAppStore.getState().setSelection([bead]);
  return bead;
}

beforeEach(() => {
  resetTestStore();
  // 描画は既存の SSR の写しを使う。ストアと model の命令はすべて本物。
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('Editing saved nested welds through the public form with real geometry and commands', () => {
  it('requires the production catalog resolver after bead creation and refuses an unknown saved generator revision', async () => {
    const f = await nestedTee();
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    const bead = weldSegmentsOf(welded).get('weld-1')?.[0];
    if (bead?.source.kind !== 'standardPart') throw new Error('Expected a generated standard-part bead');
    const library = useAppStore.getState().assemblyLibrary;
    const source = jointOccurrenceInputsOf(welded, library);
    const options = { library, subAssemblies: source.subAssemblies };
    const absent = resolveAssembly(welded, options);
    expect(absent.errors).toEqual([expect.objectContaining({ componentId: bead.id, code: 'missingPart' })]);
    expect(absent.parts.has(partKeyOf(bead.source))).toBe(false);

    const resolved = resolveAssembly(welded, { ...options, standardPart: buildStandardPartFromSource });
    expect(resolved.errors).toEqual([]);
    expect(resolved.partKeys.get(bead.id)).toBe(partKeyOf(bead.source));
    expect(resolved.parts.has(partKeyOf(bead.source))).toBe(true);
    publishSolvedView();
    expect(useAppStore.getState().assemblyView?.resolved.errors).toEqual([]);

    const damagedBead: AssemblyComponent = { ...bead, source: { ...bead.source, generatorRevision: 'unknown-test-revision' } };
    const damaged: AssemblyDocument = { ...welded,
      components: welded.components.map((component) => component.id === bead.id ? damagedBead : component) };
    const refused = resolveAssembly(damaged, { ...options, standardPart: buildStandardPartFromSource });
    expect(refused.errors).toEqual([expect.objectContaining({ componentId: bead.id, code: 'missingPart' })]);
    expect(refused.parts.has(partKeyOf(damagedBead.source))).toBe(false);
    expect(useAppStore.getState().assembly).toBe(welded);
    expect(library.assemblies?.get('child')).toBe(f.child);
  });

  it('replaces the selected bead with volume 240 mm3 on the same leaf pair and one-step Undo/Redo', async () => {
    const f = await nestedTee();
    const childSnapshot = JSON.stringify([f.child, f.standingPart, f.basePart]);
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    const oldBead = selectWeldBead(welded);
    expect(welded.jointOccurrenceConnections).toEqual([{ kind: 'weld', firstPath: STANDING_PATH, secondPath: BASE_PATH, componentIds: [oldBead] }]);

    publishSolvedView();
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: 'weld-1', legOnSecondSource: '6', legOnFirstSource: '8',
      startSource: '10', lengthsSource: '20', materialId: 'aluminum' });
    const opened = useAppStore.getState().assemblyNestedWeldPreview;
    if (opened?.kind !== 'edit' || !opened.result.ok) throw new Error(`Edit preview was rejected: ${JSON.stringify(opened)}`);
    expect(renderedForm().html).toContain(t('assembly.filletWeld.editTitle'));
    expect(opened.result.plan.nominalVolume).toBe(480);
    typeInto('fillet-weld-leg-first', '4');
    const changed = useAppStore.getState().assemblyNestedWeldPreview;
    if (changed?.kind !== 'edit' || !changed.result.ok) throw new Error(`Edit preview was rejected: ${JSON.stringify(changed)}`);
    // 6 × 4 / 2 × 20 = 240 mm³。窓の確定は押せる。
    expect(changed.result.plan.nominalVolume).toBe(240);
    expect(renderedForm().fields.get('fillet-weld-commit')?.disabled).toBe(false);
    const undoBefore = useAppStore.getState().assemblyUndoStack?.past.length ?? 0;
    submitForm();

    const edited = useAppStore.getState().assembly;
    if (edited === null || edited === welded) throw new Error('Edit commit did not change the assembly');
    const beads = weldSegmentsOf(edited).get('weld-1') ?? [];
    expect(beads).toHaveLength(1);
    const newBead = beads[0];
    if (newBead === undefined) throw new Error('New bead is missing');
    expect(newBead.id).not.toBe(oldBead);
    expect(edited.components.some((component) => component.id === oldBead)).toBe(false);
    expect(newBead.source.kind === 'standardPart' ? newBead.source.size : null).toBe('6x4');
    // 溶接線の原点 (0,34,10) から始点 10 → (10,34,10)。
    expect(newBead.placement.position.map((value) => value.value)).toEqual([10, 34, 10]);
    expect(edited.jointOccurrenceConnections).toEqual([{ kind: 'weld', firstPath: STANDING_PATH, secondPath: BASE_PATH, componentIds: [newBead.id] }]);
    expect(edited.components.slice(0, 2).map((component) => [component.id, component.placement]))
      .toEqual(welded.components.slice(0, 2).map((component) => [component.id, component.placement]));
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(undoBefore + 1);

    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(welded);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(edited);
    expect(JSON.stringify([f.child, f.standingPart, f.basePart])).toBe(childSnapshot);
    expect(useAppStore.getState().assemblyLibrary.assemblies?.get('child')).toBe(f.child);
  });

  it('rejects a stale preview without changing the document or Undo history', async () => {
    const f = await nestedTee();
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    selectWeldBead(welded);
    publishSolvedView();
    chooseAssemblyBuild('filletWeld');
    typeInto('fillet-weld-leg-first', '4');
    const ready = useAppStore.getState().assemblyNestedWeldPreview;
    if (ready?.kind !== 'edit' || !ready.result.ok) throw new Error('Edit preview is missing');
    // 解いた時の入力を前の(溶接の前の)文書のものにする: 表示が今の文書と食い違う。
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('Assembly view is missing');
    useAppStore.setState({ assemblyView: { ...view, source: jointOccurrenceInputsOf(f.document, useAppStore.getState().assemblyLibrary) } });
    const undoBefore = useAppStore.getState().assemblyUndoStack?.past.length ?? 0;
    submitForm();
    expect(useAppStore.getState().assembly).toBe(welded);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(undoBefore);
    expect(useAppStore.getState().assemblyFilletWeldPreview?.kind).toBe('issue');
  });

  it('rejects damaged association metadata without falling back to flat weld editing', async () => {
    const f = await nestedTee();
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    const bead = selectWeldBead(welded);
    // 結び付けに、無いビードの id を混ぜた文書を開き直す(記録の食い違い)。
    const damaged: AssemblyDocument = { ...welded, jointOccurrenceConnections: [
      { kind: 'weld', firstPath: STANDING_PATH, secondPath: BASE_PATH, componentIds: [bead, 'ghost-bead'] }] };
    useAppStore.getState().openAssembly(damaged, useAppStore.getState().assemblyLibrary);
    publishSolvedView();
    selectWeldBead(damaged);
    chooseAssemblyBuild('filletWeld');
    const refused = useAppStore.getState().assemblyNestedWeldPreview;
    expect(refused?.kind === 'edit' && !refused.result.ok ? refused.result.reason : refused).toBe('weld-association-damaged');
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'occurrence', reason: 'weld-association-damaged' } });
    expect(useAppStore.getState().commitFilletWeld()).toBe(false);
    expect(useAppStore.getState().assembly).toBe(damaged);
  });

  it('rejects a wrong-kind bead association and preserves the document and history', async () => {
    const f = await nestedTee();
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    const bead = selectWeldBead(welded);
    const damaged: AssemblyDocument = { ...welded, jointOccurrenceConnections: [
      { kind: 'bolt', firstPath: STANDING_PATH, secondPath: BASE_PATH, componentIds: [bead] }] };
    useAppStore.getState().openAssembly(damaged, useAppStore.getState().assemblyLibrary);
    publishSolvedView();
    selectWeldBead(damaged);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({
      kind: 'issue', issue: { kind: 'occurrence', reason: 'weld-association-damaged' } });
    expect(useAppStore.getState().commitFilletWeld()).toBe(false);
    expect(useAppStore.getState().assembly).toBe(damaged);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('replaces one bead with three at independent starts 5, 20, 40 and volume 420 with one-step Undo', async () => {
    const f = await nestedTee();
    const childSnapshot = JSON.stringify([f.child, f.standingPart, f.basePart]);
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    const oldBead = selectWeldBead(welded);
    publishSolvedView();
    chooseAssemblyBuild('filletWeld');
    useAppStore.getState().updateFilletWeldDraft({ legOnFirstSource: '4', mode: 'intermittent',
      startSource: '5', lengthsSource: '10, 15, 10', gapsSource: '5, 5' });
    const preview = useAppStore.getState().assemblyNestedWeldPreview;
    if (preview?.kind !== 'edit' || !preview.result.ok) throw new Error('Three-segment preview is missing');
    expect(preview.result.plan.nominalVolume).toBe(6 * 4 / 2 * 35);
    const undoBefore = useAppStore.getState().assemblyUndoStack?.past.length ?? 0;
    submitForm();
    const edited = useAppStore.getState().assembly;
    if (edited === null) throw new Error('Assembly is missing');
    const beads = weldSegmentsOf(edited).get('weld-1') ?? [];
    expect(beads).toHaveLength(3);
    expect(beads.map((bead) => bead.placement.position.map((value) => value.value)))
      .toEqual([[5, 34, 10], [20, 34, 10], [40, 34, 10]]);
    expect(edited.components.some((component) => component.id === oldBead)).toBe(false);
    expect(new Set(beads.map((bead) => bead.id)).size).toBe(3);
    expect(edited.jointOccurrenceConnections).toEqual([{ kind: 'weld', firstPath: STANDING_PATH,
      secondPath: BASE_PATH, componentIds: beads.map((bead) => bead.id) }]);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(undoBefore + 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(welded);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(edited);
    expect(JSON.stringify([f.child, f.standingPart, f.basePart])).toBe(childSnapshot);
  });

  it('rejects missing nested-owner association metadata without falling back to flat weld editing', async () => {
    const f = await nestedTee();
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    const damaged: AssemblyDocument = { ...welded, jointOccurrenceConnections: [] };
    useAppStore.getState().openAssembly(damaged, useAppStore.getState().assemblyLibrary);
    publishSolvedView();
    selectWeldBead(damaged);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({
      kind: 'issue', issue: { kind: 'occurrence', reason: 'weld-association-missing' } });
    expect(useAppStore.getState().commitFilletWeld()).toBe(false);
    expect(useAppStore.getState().assembly).toBe(damaged);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('removes the bead and association but retains root and child owners and restores the weld with Undo', async () => {
    const f = await nestedTee();
    const childSnapshot = JSON.stringify([f.child, f.standingPart, f.basePart]);
    useAppStore.getState().openAssembly(f.document, f.library);
    publishSolvedView();
    const welded = createNestedWeld();
    selectWeldBead(welded);
    publishSolvedView();
    chooseAssemblyBuild('filletWeld');
    const undoBefore = useAppStore.getState().assemblyUndoStack?.past.length ?? 0;
    expect(useAppStore.getState().removeFilletWeldDraft()).toBe(true);
    const removed = useAppStore.getState().assembly;
    expect(removed?.components.map((component) => component.id)).toEqual([OWNER, 'base']);
    expect(removed?.jointOccurrenceConnections ?? []).toEqual([]);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(undoBefore + 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(welded);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(removed);
    expect(JSON.stringify([f.child, f.standingPart, f.basePart])).toBe(childSnapshot);
  });
});
