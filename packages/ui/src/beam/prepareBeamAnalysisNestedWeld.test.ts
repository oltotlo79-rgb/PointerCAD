import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAssembly, buildStandardPartFromSource } from '@pointercad/model';
import { nestedWeldFixture } from '../../../model/src/analysis/cadWeldLayerNested.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { beamUiFixture } from './beam.testSupport.js';
import type { BeamSourceSnapshot } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

beforeEach(resetTestStore);

/**
 * r3 wiring through the real preparation route: the same saved nested weld is prepared with and without the snapshot's
 * jointOccurrence. Removing the wiring (prepareBeamAnalysis not forwarding it) makes the first case fail exactly like
 * the second.
 */
function snapshots() {
  const f = nestedWeldFixture();
  const ui = beamUiFixture();
  const ownership = { ...ui.owner, document: f.document, activeDocumentId: f.document.id, bodies: f.adapter.bodies };
  const resolved = resolveAssembly(f.document, { library: f.library, subAssemblies: f.library.assemblies, standardPart: buildStandardPartFromSource });
  const withContext: BeamSourceSnapshot = { document: f.document, library: f.library, ownership, resolved,
    source: f.adapter.currentSource, jointOccurrence: f.adapter.jointOccurrence };
  const { jointOccurrence, ...withoutContext } = withContext;
  const definition = { ...f.definition, weldLayers: f.associations };
  return { withContext, withoutContext, jointOccurrence, definition };
}

describe('prepareBeamAnalysis forwards the snapshot joint occurrence context to the nested weld adapter', () => {
  it('prepares the nested weld contact when the snapshot carries the context', () => {
    const s = snapshots();
    expect(s.jointOccurrence).toBeDefined();
    const prepared = prepareBeamAnalysis(s.withContext, s.definition);
    expect(prepared.ok ? prepared.kind : prepared.issue.message).toBe('weld-contact');
  });

  it('refuses the same nested weld when the snapshot has no context', () => {
    const s = snapshots();
    expect('jointOccurrence' in s.withoutContext).toBe(false);
    const prepared = prepareBeamAnalysis(s.withoutContext, s.definition);
    expect(prepared.ok).toBe(false);
    expect(prepared.ok ? '' : prepared.issue.message).toMatch(/Nested weld groups need the current joint occurrence view/);
  });
});
