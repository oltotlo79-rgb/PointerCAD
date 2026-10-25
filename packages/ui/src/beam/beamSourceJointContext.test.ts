import { beforeEach, describe, expect, it } from 'vitest';
import { buildStandardPartFromSource, resolveConstrainedAssembly } from '@pointercad/model';
import { cadAxialBoltFixture } from '../../../model/src/analysis/cadAxialBolt.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { nestedJointCommandContext } from '../assembly/nestedWeldDraft.js';
import { beamUiFixture } from './beam.testSupport.js';
import { captureBeamSource } from './beamSource.js';

beforeEach(resetTestStore);

/**
 * r3 wiring: the analysis snapshot carries the same joint occurrence command context that the nested weld editor builds
 * from the current store document, library and view. Without it, nested weld groups are refused by the weld adapter.
 */
function state() {
  const ui = beamUiFixture(), cad = cadAxialBoltFixture();
  const document = cad.document;
  const owner = { ...ui.owner, document, activeDocumentId: document.id };
  const resolved = resolveConstrainedAssembly(document, owner.bodies, { standardPart: buildStandardPartFromSource });
  if (!resolved.ok || ui.state.assemblyView === null) throw new Error('Actual CAD fixture did not resolve');
  return { ...ui.state, assembly: document, activeDocumentId: document.id,
    assemblyView: { ...ui.state.assemblyView, sourceDocument: document, resolved: resolved.resolved, meshOwnership: owner } };
}

describe('beam source snapshot carries the nested joint occurrence context', () => {
  it('captures the context built from the same store document, library and view as the nested weld editor', () => {
    const current = state();
    const source = captureBeamSource(current);
    if (source === null) throw new Error('Expected current owned publication');
    const expected = current.assembly === null || current.assemblyView === null ? null
      : nestedJointCommandContext(current.assembly, current.assemblyLibrary, current.assemblyView);
    // Present exactly when the editor's own context exists; the same inputs and view, not a re-derived scene.
    expect(source.jointOccurrence === undefined).toBe(expected === null);
    if (expected !== null && source.jointOccurrence !== undefined) {
      expect(source.jointOccurrence.inputs).toStrictEqual(expected.inputs);
      expect(source.jointOccurrence.view).toStrictEqual(expected.view);
    }
  });

  it('captures no snapshot (and so no context) while a computation is pending', () => {
    expect(captureBeamSource({ ...state(), isComputing: true })).toBeNull();
  });
});
