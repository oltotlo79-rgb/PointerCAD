import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  resolveAssembly, type AssemblyComponent, type AssemblyDocument, type ComponentSource, type JointOccurrenceInputs,
  type Placement, type PrimitiveFeature, type Quaternion,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import { shownOccurrencePlacements } from '../store/assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { flattenAssemblyGeometry } from '../viewport/createAssemblyLayer.js';
import { AssemblyPropertyPanel } from './AssemblyPropertyPanel.js';
import { SubAssemblyJointControls, subAssemblyOccurrencePathOf } from './SubAssemblyJointControls.js';

/*
 * Visible boundary of the flexible subassembly drive at any depth. Two-level fixture (positions written by hand):
 * leaf = fixed base + free arm on a slider along the origin z axes; mid = fixed part `mid-base` plus the leaf placed as
 * `M` at (0, 0, 5); the parent places mid twice: A turned 90 degrees about z at (10, 20, 0), B at (0, 0, 10).
 * The leaf arm of A/M is at (10, 20, 5) before driving and at (10, 20, 5 + t) after driving the slider by t.
 * Fixture times are historical fixture data, not an execution clock.
 */
const HALF = Math.SQRT1_2;
const TURN_Z: Quaternion = [0, 0, HALF, HALF];
const SLIDE = 'child-slide';

function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}
function component(id: string, source: ComponentSource, at: Placement = placement(0, 0, 0), fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}

async function publish(): Promise<void> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const leaf: AssemblyDocument = { ...createAssemblyDocument('leaf'),
    components: [component('base', part, placement(0, 0, 0), true), component('arm', part)],
    joints: [{ id: SLIDE, name: SLIDE, kind: 'slider', a: { kind: 'origin', componentId: 'arm', element: 'z' },
      b: { kind: 'origin', componentId: 'base', element: 'z' }, minValue: null, maxValue: null, suppressed: false }] };
  const mid: AssemblyDocument = { ...createAssemblyDocument('mid'), components: [component('mid-base', part, placement(0, 0, 0), true),
    component('M', { kind: 'subAssembly', assemblyRef: 'leaf' }, placement(0, 0, 5))] };
  const subAssemblies = new Map([['leaf', leaf], ['mid', mid]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('A', { kind: 'subAssembly', assemblyRef: 'mid' }, placement(10, 20, 0, TURN_Z)),
    component('B', { kind: 'subAssembly', assemblyRef: 'mid' }, placement(0, 0, 10)),
  ] };
  useAppStore.getState().openAssembly(document, library);
  const source: JointOccurrenceInputs = { document, library, subAssemblies };
  useAppStore.setState({ assemblyView: { sourceDocument: document, source, resolved: resolveAssembly(document, { library, subAssemblies }),
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), mateTargets: new Map(), jointFrames: new Map() } });
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

const label = `${SLIDE} ${t('assembly.motion.translation')}`;
const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, match => `\\${match}`);
const field = (html: string): string | undefined => new RegExp(`<input[^>]*aria-label="${escaped}"[^>]*>`, 'u').exec(html)?.[0];
const shownValue = (input: string | undefined): number => Number(/value="([^"]*)"/u.exec(input ?? '')?.[1] ?? Number.NaN);

describe('flexible subassembly joint controls at any depth', () => {
  it('maps tree row ids to occurrence paths from the resolved tree, refusing parts and unknown rows', async () => {
    await publish();
    const { assembly, assemblyView } = useAppStore.getState();
    if (assembly === null) throw new Error('assembly');
    expect(subAssemblyOccurrencePathOf(assembly, assemblyView, 'A')).toEqual(['A']);
    expect(subAssemblyOccurrencePathOf(assembly, assemblyView, 'A/M')).toEqual(['A', 'M']);
    expect(subAssemblyOccurrencePathOf(assembly, assemblyView, 'B/M')).toEqual(['B', 'M']);
    expect(subAssemblyOccurrencePathOf(assembly, assemblyView, 'A/mid-base')).toBeNull();
    expect(subAssemblyOccurrencePathOf(assembly, assemblyView, 'A/M/arm')).toBeNull();
    expect(subAssemblyOccurrencePathOf(assembly, assemblyView, 'X')).toBeNull();
    expect(subAssemblyOccurrencePathOf(assembly, null, 'A/M')).toBeNull();
  });

  it('shows the nested placement controls when its tree row is selected, with a label and a description', async () => {
    await publish();
    useAppStore.setState({ selection: ['A/M'] });
    const panel = renderToStaticMarkup(<AssemblyPropertyPanel />);
    expect(panel).toContain('data-occurrence-path="A/M"');
    expect(panel).toContain(t('assembly.subJoint.hint'));
    expect(panel).not.toContain(t('propertyPanel.empty'));
    const input = field(panel) ?? '';
    expect(input).toContain(`title="${t('assembly.subJoint.guide').replace('{joint}', label)}"`);
    expect(input).toContain('value=""');
    expect(input).not.toContain('disabled');
    // The top-level placement of mid has no joint of its own: its section says so instead of offering a field.
    useAppStore.setState({ selection: ['A'] });
    const top = renderToStaticMarkup(<AssemblyPropertyPanel />);
    expect(top).toContain('data-occurrence-path="A"');
    expect(top).toContain(t('assembly.subJoint.none'));
  });

  it('drives the leaf joint of one nested placement only and shows it only there, transiently', async () => {
    await publish();
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A', 'M'], SLIDE, 'translation', 5)).toBe(true);
    expect(shownValue(field(renderToStaticMarkup(<SubAssemblyJointControls path={['A', 'M']} />)))).toBeCloseTo(5, 9);
    expect(field(renderToStaticMarkup(<SubAssemblyJointControls path={['B', 'M']} />))).toContain('value=""');
    const state = useAppStore.getState();
    const view = state.assemblyView, document = state.assembly;
    if (view === null || document === null) throw new Error('view');
    const flat = flattenAssemblyGeometry(document, view.resolved, view.resolved.placements, shownOccurrencePlacements(state));
    expect(flat.placements.get('A/M/arm')?.position).toEqual([expect.closeTo(10, 9), expect.closeTo(20, 9), expect.closeTo(10, 9)]);
    expect(flat.placements.get('A/M/base')?.position[2]).toBeCloseTo(5, 9);
    expect(flat.placements.get('A/mid-base')?.position[2]).toBeCloseTo(0, 9);
    expect(flat.placements.get('B/M/arm')?.position[2]).toBeCloseTo(15, 9);
    expect(state.assemblyUndoStack?.past ?? []).toHaveLength(0);
    // Without the drive the same document shows the resolved placements again (transient state only).
    useAppStore.getState().clearAssemblyOccurrenceDrives();
    const plain = flattenAssemblyGeometry(document, view.resolved, view.resolved.placements, shownOccurrencePlacements(useAppStore.getState()));
    expect(plain.placements.get('A/M/arm')?.position[2]).toBeCloseTo(5, 9);
  });

  it('keeps an unrelated or stale selection on the empty placeholder', async () => {
    await publish();
    for (const row of ['A/mid-base', 'A/M/arm', 'X/M']) {
      useAppStore.setState({ selection: [row] });
      const panel = renderToStaticMarkup(<AssemblyPropertyPanel />);
      expect(panel).toContain(t('propertyPanel.empty'));
      expect(panel).not.toContain('data-testid="assembly-subjoint-controls"');
    }
    // A recomputed view of another document (stale) gives no nested path either.
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('view');
    useAppStore.setState({ assemblyView: { ...view, sourceDocument: createAssemblyDocument('other') }, selection: ['A/M'] });
    expect(renderToStaticMarkup(<AssemblyPropertyPanel />)).toContain(t('propertyPanel.empty'));
  });

  it('shows nothing for an unknown path and disables the fields without a current view', async () => {
    await publish();
    expect(renderToStaticMarkup(<SubAssemblyJointControls path={['missing']} />)).toBe('');
    expect(renderToStaticMarkup(<SubAssemblyJointControls path={['A', 'mid-base']} />)).toBe('');
    useAppStore.setState({ assemblyView: null });
    expect(field(renderToStaticMarkup(<SubAssemblyJointControls path={['A', 'M']} />))).toContain('disabled');
  });
});
