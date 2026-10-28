import { beforeEach, describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument, type HoleFeature, type ImportedSolidFeature, type KernelBridge, type SolidBody } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { ReferenceMeshScope } from '../../../model/src/part/readReferenceBodies.js';
import { bodyFor, resetTestStore } from '../store/testing/createTestStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AppState } from '../store/appState.js';
import { currentPlanarHoleBasis } from './PlanarHoleBasisInfo.js';
import { createSolidPropertyFieldEdit, reconcileCylindricalPropertySelection } from '../shell/PropertyPanel.js';

beforeEach(resetTestStore);

/** 制御providerの所有契約を実ReferenceMeshScopeで確認する。native計算成功とは数えない。 */
async function fixture(rotated = false) {
  const n = expressionValueFromNumber;
  const basis = rotated ? { origin: [11, -7, 5], xAxis: [.6, .8, 0],
    yAxis: [-.64, .48, -.6], normal: [-.48, .36, .8] }
    : { origin: [0, 0, 10], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };
  const upstream: SolidBody = { ...bodyFor('planar-xy-stock'), faces: [{ index: 4, surfaceKind: 'plane',
    area: 1200, centroid: rotated ? [11, -7, 5] : [0, 0, 10], axis: rotated ? [-.48, .36, .8] : [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1,
    planarBasis: { origin: rotated ? [11, -7, 5] : [0, 0, 10], xAxis: rotated ? [.6, .8, 0] : [1, 0, 0],
      yAxis: rotated ? [-.64, .48, -.6] : [0, 1, 0], normal: rotated ? [-.48, .36, .8] : [0, 0, 1] } }] };
  const feature: HoleFeature = { id: 'hole-1', name: '穴1', kind: 'hole', suppressed: false,
    targetFeatureId: 'planar-xy-stock', face: { bodyFeatureId: 'planar-xy-stock', index: 4,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1200, position: rotated ? [11, -7, 5] : [0, 0, 10], axis: rotated ? [-.48, .36, .8] : [0, 0, 1], radius: null } },
    centers: [], planar: { kind: 'plane-face', locations: [{ x: { ...n(6), source: '2*3' }, y: { ...n(-4), source: '-2*2' } }] },
    diameter: n(6), depth: { kind: 'through' }, tiltAngle: n(0), tiltAzimuth: n(0) };
  const stock: ImportedSolidFeature = { id: 'planar-xy-stock', kind: 'importedSolid', name: '面内XY素材', suppressed: false,
    shapeRef: 'fixed-stock', bodyKind: 'solid',
    source: { format: 'step', fileName: 'stock.step', unit: 'mm', byteLength: 1 } };
  const document = appendSolid(appendSolid(createEmptyPartDocument(), stock), feature);
  const hidden = [upstream];
  const owner: NonNullable<ReturnType<NonNullable<KernelBridge['meshLedgerOwner']>>> = {
    dispatchId: 'planar-property-hidden', partId: 'planar-property', generation: 7,
    kind: 'hidden', steps: [{ id: upstream.featureId, key: 'stock-key' }] };
  const scope = new ReferenceMeshScope(document, { partId: 'planar-property', generation: 7, maximumLiveMeshBytes: 1000 }, {
    meshLedgerOwner: bodies => bodies === hidden ? owner : null,
    captureCurrentMeshLedger: input => Promise.resolve({ status: 'unknown', observationId: input.observationId, reason: 'not-published' }),
    currentMeshLedgerReceipt: () => false,
    releaseReferenceMeshLease: () => Promise.resolve({ released: true }),
  });
  await scope.register(hidden);
  const body: SolidBody = { ...bodyFor(feature.id), coordinateFrame: { space: 'local', origin: [0, 0, 0],
    maximumFloat32ErrorMm: .01, maximumLiveMeshBytes: 1000 } };
  const bodies = [body], initial = useAppStore.getState();
  const state: AppState = { ...initial, document, activeDocumentId: 'planar-session', bodies,
    selection: [feature.id], assembly: null, drawing: null, isComputing: false, stagedSolid: null,
    sheetMetalTool: null, sheetMetalPreview: null, requestedGeneration: 7, completedGeneration: 7,
    lastOutcome: 'success', recomputeCancelled: false, timelineIndex: null,
    mathGeometryResult: { document, generation: 7, evaluated: true, outcomes: new Map() },
    meshJsAccounting: { document, bodies, bodyLayouts: bodies.map(captureMeshBodyLayout), activeDocumentId: 'planar-session',
      timelineIndex: null, outcome: 'success', receipt: { documentId: document.id, partId: 'planar-property', generation: 7,
        reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 100,
          cacheProtectedBytes: 200, retainedReplyBytes: 200, requestPeakReservedBytes: 900 },
        final: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 0,
          cacheProtectedBytes: 100, displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 160,
          replyCloneReservedBytes: 60 } } },
    referenceRepairBodies: { document, activeDocumentId: 'planar-session', generation: 7,
      bodies: hidden, displayBodies: bodies, scope } };
  return { state, feature, upstream, scope, basis };
}

describe('planar property basis on a consumed upstream face', () => {
  it.each([false, true])('resolves the unchanged saved upstream reference, rotated=%s', async rotated => {
    const f = await fixture(rotated);
    try {
      expect(f.state.bodies.map(body => body.featureId)).toEqual(['hole-1']);
      expect(f.scope.referenceBodyCurrent(f.upstream)).toBe(true);
      expect(currentPlanarHoleBasis(f.state, f.feature)).toEqual(f.basis);
      expect(currentPlanarHoleBasis({ ...f.state, referenceRepairBodies: null }, f.feature)).toBeNull();
      const before = f.state.document, history = f.state.undoStack, reference = f.feature.face;
      const selection = reconcileCylindricalPropertySelection(f.feature, null);
      const edit = createSolidPropertyFieldEdit(f.feature, 'holePlanarY', selection, { lengthUnit: 'mm', variables: new Map(),
        exactVariables: new Map(), nonLengthVariables: new Set(), pendingVariables: new Set() });
      const value = { ...expressionValueFromNumber(-5), source: '-(1+4)' };
      const next = edit.replaceValue(before, value), changed = next.solids.find(row => row.id === f.feature.id);
      if (changed?.kind !== 'hole') throw new Error('Missing updated hole');
      expect(changed.face).toBe(reference); expect(changed.id).toBe(f.feature.id);
      expect(changed.planar?.locations[0].x).toBe(f.feature.planar?.locations[0].x);
      expect(changed.planar?.locations[0].y).toBe(value);
      const prepared = { ...before, mathParameterSerial: 1 };
      expect(edit.replaceValue(prepared, value).mathParameterSerial).toBe(1);
      expect(f.state.document).toBe(before); expect(f.state.undoStack).toBe(history);
      expect(currentPlanarHoleBasis(f.state, { ...f.feature })).toBeNull();
    } finally { await f.scope.close(); }
  });

  it.each(['different document', 'different session', 'wrong generation', 'wrong display', 'closed scope',
    'unowned body', 'unknown face', 'retired feature', 'stale math', 'computing', 'missing receipt'])(
    'refuses %s without substituting a final-body face', async scenario => {
      const f = await fixture();
      try {
        const snapshot = f.state.referenceRepairBodies;
        if (snapshot === null) throw new Error('Missing fixture snapshot');
        let state = f.state;
        if (scenario === 'different document') state = { ...state, referenceRepairBodies: { ...snapshot, document: { ...state.document } } };
        if (scenario === 'different session') state = { ...state, referenceRepairBodies: { ...snapshot, activeDocumentId: 'old-session' } };
        if (scenario === 'wrong generation') state = { ...state, referenceRepairBodies: { ...snapshot, generation: 6 } };
        if (scenario === 'wrong display') state = { ...state, referenceRepairBodies: { ...snapshot, displayBodies: [...state.bodies] } };
        if (scenario === 'closed scope') await f.scope.close();
        if (scenario === 'unowned body') state = { ...state, referenceRepairBodies: { ...snapshot, bodies: [{ ...f.upstream }] } };
        if (scenario === 'unknown face') Object.defineProperty(f.upstream, 'faces', { value: [] });
        if (scenario === 'retired feature') state = { ...state, document: { ...state.document, solids: [] } };
        if (scenario === 'stale math') state = { ...state, mathGeometryResult: null };
        if (scenario === 'computing') state = { ...state, isComputing: true };
        if (scenario === 'missing receipt') state = { ...state, meshJsAccounting: null };
        expect(currentPlanarHoleBasis(state, f.feature)).toBeNull();
        expect(f.feature.face.bodyFeatureId).toBe('planar-xy-stock');
      } finally { await f.scope.close(); }
    });
});
