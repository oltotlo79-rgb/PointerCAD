import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStandardPartFromSource, createEmptyPartDocument, partKeyOf, resolveConstrainedAssembly } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { cadWeldSpanFixture } from '../../../model/src/analysis/cadWeldSpanLayer.testSupport.js';
import { cadWeldLayerFixture } from '../../../model/src/analysis/cadWeldLayer.testSupport.js';
import { cadJointContactFixture } from '../../../model/src/analysis/cadJointContact.testSupport.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import type { AssemblySourceMeshOwner } from '../viewport/assemblyMeshAdmission.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { beamDefinition, restoreBeamSession } from './beamSession.js';
import { captureBeamSource } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';
import { BeamWeldLayerDefinitions } from './BeamWeldLayers.js';
import { BeamWeldSpanDefinitions } from './BeamWeldSpanDefinitions.js';

// Actual CAD planner/beads and independent 10mm/2mm/1mm inputs; publication ownership is unit metadata, not native evidence.
function fixture(mixed = false, grouped = false) {
  const ui = beamUiFixture(), cad = cadWeldSpanFixture(mixed, grouped ? [{ start: 2, length: 3 }, { start: 10, length: 5 }] : undefined);
  const sources = new Map<string, AssemblySourceMeshOwner>();
  for (const [key, bodies] of cad.context.bodies) {
    const part = createEmptyPartDocument(), result = { ...resultFor(part), bodies, generation: ui.owner.generation };
    sources.set(key, { document: part, attachments: undefined, result, bodies,
      layouts: bodies.map(captureMeshBodyLayout), displayOwner: null, hiddenOwners: [], current: () => true });
  }
  const owner = { ...ui.owner, document: cad.document, activeDocumentId: cad.document.id, bodies: cad.context.bodies, sources };
  const resolved = resolveConstrainedAssembly(cad.document, owner.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok || ui.state.assemblyView === null) throw new Error('Actual span CAD must resolve');
  const state = { ...ui.state, assembly: cad.document, activeDocumentId: cad.document.id,
    assemblyView: { ...ui.state.assemblyView, sourceDocument: cad.document, bodies: owner.bodies,
      resolved: resolved.resolved, meshOwnership: owner } };
  const source = captureBeamSource(state);
  if (source === null) throw new Error('Current publication required');
  const associations = { ...cad.associations, source: source.source };
  const definition = { ...cad.definition, source: source.source, weldLayers: associations };
  const occurrences = cad.document.components.map(c => ({ path: [c.id], partKey: partKeyOf(c.source), label: c.name }));
  const restored = restoreBeamSession(cad.document.id, definition, occurrences);
  const session = { ...restored, weldSpanLayers: null, members: restored.members.map(m => ({ ...m, confirmed: true })) };
  useAppStore.setState({ ...state, beamSession: session });
  return { source, associations, occurrences, session };
}

interface Props {
  readonly children?: ReactNode;
  readonly 'data-span-side'?: string;
  readonly 'data-span-field'?: string;
  readonly 'data-testid'?: string;
  readonly disabled?: boolean;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
  readonly onClick?: () => void;
}
interface Control { readonly props: Props; readonly side?: string }
function controls(): readonly Control[] {
  const found: Control[] = [];
  function walk(node: ReactNode, side?: string): void {
    Children.forEach(node, child => {
      if (!isValidElement<Props>(child)) return;
      const next = child.props['data-span-side'] ?? side;
      found.push({ props: child.props, side: next });
      walk(child.props.children, next);
    });
  }
  function Probe(): null { walk(BeamWeldSpanDefinitions({ session: requireBeamSession() })); return null; }
  renderToStaticMarkup(<Probe />);
  return found;
}
function change(field: string, value: string, side?: string): void {
  const handler = controls().find(c => c.props['data-span-field'] === field && c.side === side)?.props.onChange;
  if (handler === undefined) throw new Error(`Missing real control ${field}/${side}`);
  handler({ target: { value } });
}
function add(): void {
  const handler = controls().find(c => c.props['data-testid'] === 'beam-weld-span-add')?.props.onClick;
  if (handler === undefined) throw new Error('Missing add');
  handler();
}
function author(mixed = false, grouped = false) {
  const f = fixture(mixed, grouped);
  add();
  change('bead', f.associations.welds[0].beadComponentId);
  change('member', 'a-beam', 'first');
  change('member', 'b-beam', 'second');
  if (mixed) { change('kind', 'section-node', 'first'); change('node', 'a-base', 'first'); }
  for (const [field, value] of [['youngMPa', '1000'], ['poisson', '.25'], ['effectiveThroatMm', '2'], ['complianceLengthMm', '1'],
    ['reference', 'Independent rectangular fixture'], ['condition', 'Linear isotropic elastic test, not a capacity rating']]) change(field, value);
  return f;
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('explicit span authoring through real editBeam callbacks', () => {
  it.each([false, true])('authors and saves/reads/prepares real span geometry (section=%s)', mixed => {
    const f = author(mixed), session = requireBeamSession(), original = JSON.stringify(f.source.document);
    const checked = beamDefinition(session, f.source, []);
    if (!checked.ok) throw new Error(`Authored definition rejected: ${checked.diagnostic}`);
    const saved = withBeamAnalysisInputs(f.source.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: checked.definition }] });
    const read = readBeamAnalysisInputs(saved.beamAnalysisInputs, saved.id);
    if (!read.ok || read.value.analyses[0]?.kind !== 'standard-members') throw new Error('Strict saved input required');
    const restored = restoreBeamSession(saved.id, read.value.analyses[0].definition, f.occurrences);
    expect(restored.weldSpanLayers).toEqual(session.weldSpanLayers);
    const prepared = prepareBeamAnalysis(f.source, read.value.analyses[0].definition);
    if (!prepared.ok || prepared.kind !== 'weld-span-contact') throw new Error('Real strict span preparation required');
    expect(prepared.input.patches[0]).toMatchObject({ widthM: .01, lengthM: .002, thicknessM: .001, youngPa: 1e9, poisson: .25 });
    expect(prepared.input.patches[0].first).toEqual(mixed ? { kind: 'section-node', memberId: 'a-beam', nodeId: 'a-base' }
      : { kind: 'member-span', memberId: 'a-beam' });
    expect(prepared.input.patches[0].second).toEqual({ kind: 'member-span', memberId: 'b-beam' });
    expect(JSON.stringify(f.source.document)).toBe(original);
    expect(useAppStore.getState().assembly).toBe(f.source.document);
    expect(session.weldLayers).toEqual([]);
  });

  it('selects and updates every actual irregular group interval; last group deletion becomes null', () => {
    const f = author(false, true);
    expect(requireBeamSession().weldSpanLayers?.welds.map(w => w.beadComponentId)).toEqual(f.associations.welds.map(w => w.beadComponentId));
    change('youngMPa', '1200');
    expect(requireBeamSession().weldSpanLayers?.welds.map(w => w.youngMPa)).toEqual([1200, 1200]);
    const checked = beamDefinition(requireBeamSession(), f.source, []);
    if (!checked.ok) throw new Error('Full group definition required');
    const prepared = prepareBeamAnalysis(f.source, checked.definition);
    if (!prepared.ok || prepared.kind !== 'weld-span-contact') throw new Error('Full group preparation required');
    expect(prepared.input.patches.map(p => p.widthM)).toEqual([.003, .005]);
    controls().find(c => c.props['data-span-field'] === 'remove')?.props.onClick?.();
    expect(requireBeamSession().weldSpanLayers).toBeNull();
  });

  it.each(['legacy', 'bolt', 'strain'] as const)('refuses mixed %s without conversion or data/history changes', kind => {
    const f = fixture(), old = cadWeldLayerFixture(), joint = cadJointContactFixture();
    const session = { ...f.session, ...(kind === 'legacy' ? { weldLayers: old.associations.welds } : kind === 'bolt'
      ? { axialBolts: joint.axialBolts.bolts } : { initialStrain: { schema: 'pointercad-cad-joint-initial-strain/1' as const, shortenings: [] } }) };
    useAppStore.setState({ beamSession: session });
    const before = useAppStore.getState();
    expect(controls().find(c => c.props['data-testid'] === 'beam-weld-span-add')?.props.disabled).toBe(true);
    add();
    expect(useAppStore.getState()).toBe(before);
    expect(requireBeamSession().weldSpanLayers).toBeNull();
    expect(requireBeamSession().weldLayers).toBe(session.weldLayers);
  });

  it.each(['', '0', '-1', 'Infinity'])('incomplete/invalid authored number %s cannot save or prepare', value => {
    const f = author();
    change('effectiveThroatMm', value);
    const checked = beamDefinition(requireBeamSession(), f.source, []);
    expect(checked.ok).toBe(false);
    expect(useAppStore.getState().assembly).toBe(f.source.document);
  });

  it('explicit section selection requires a real endpoint and switching back never fabricates a node', () => {
    const f = author(true);
    change('node', 'fabricated-node', 'first');
    expect(requireBeamSession().weldSpanLayers?.welds[0].first).toEqual({ kind: 'section-node', memberId: 'a-beam', nodeId: 'a-base' });
    change('kind', 'member-span', 'first');
    expect(requireBeamSession().weldSpanLayers?.welds[0].first).toEqual({ kind: 'member-span', memberId: 'a-beam' });
    change('kind', 'section-node', 'first');
    expect(requireBeamSession().weldSpanLayers?.welds[0].first).toEqual({ kind: 'section-node', memberId: 'a-beam', nodeId: '' });
    expect(beamDefinition(requireBeamSession(), f.source, []).ok).toBe(false);
  });

  it('invalidates review/result once per edit, preserves document/history, and rejects a retained callback', () => {
    const f = author(), session = requireBeamSession(), runner = { cancel: vi.fn(), run: vi.fn() };
    useAppStore.setState({ beamSession: { ...session, reviewed: f.source }, beamRunner: runner });
    const before = useAppStore.getState(), oldHandler = controls().find(c => c.props['data-span-field'] === 'youngMPa')?.props.onChange;
    change('youngMPa', '1200');
    expect(requireBeamSession().reviewed).toBeNull();
    expect(requireBeamSession().result).toBeNull();
    expect(requireBeamSession().revision).toBe(session.revision + 1);
    expect(runner.cancel).toHaveBeenCalledTimes(1);
    const after = useAppStore.getState();
    oldHandler?.({ target: { value: '9999' } });
    expect(useAppStore.getState()).toBe(after);
    expect(after.assembly).toBe(before.assembly);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('does not rebind stale source and does not auto-convert the legacy entry', () => {
    const f = author(), session = requireBeamSession(), span = session.weldSpanLayers;
    if (span === null) throw new Error('Authored span required');
    useAppStore.setState({ beamSession: { ...session, weldSpanLayers: { ...span, source: { ...span.source, geometryRevision: 'stale' } } } });
    const before = useAppStore.getState();
    change('youngMPa', '1200');
    expect(useAppStore.getState()).toBe(before);
    expect(beamDefinition(requireBeamSession(), f.source, []).ok).toBe(false);
    let selected: ReactNode;
    function Probe(): null { selected = BeamWeldLayerDefinitions({ session: requireBeamSession() }); return null; }
    renderToStaticMarkup(<Probe />);
    expect(isValidElement(selected) && selected.type).toBe(BeamWeldSpanDefinitions);
  });
});
