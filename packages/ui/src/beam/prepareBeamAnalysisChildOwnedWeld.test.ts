import { beforeEach, describe, expect, it } from 'vitest';
import { buildStandardPartFromSource, resolveAssembly } from '@pointercad/model';
import { childOwnedWeldFixture } from '../../../model/src/analysis/cadWeldLayerChildOwned.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { beamUiFixture } from './beam.testSupport.js';
import type { BeamSourceSnapshot } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

beforeEach(resetTestStore);

describe('prepareBeamAnalysis routes a child-owned weld group of a repeated child through the real adapter', () => {
  it('prepares one weld layer per occurrence from the snapshot library subassemblies', () => {
    const f = childOwnedWeldFixture();
    const ui = beamUiFixture();
    const library = { ...ui.state.assemblyLibrary, assemblies: f.subAssemblies };
    const ownership = { ...ui.owner, document: f.document, activeDocumentId: f.document.id, bodies: f.context.bodies };
    const resolved = resolveAssembly(f.document, { library, subAssemblies: f.subAssemblies, standardPart: buildStandardPartFromSource });
    const snapshot: BeamSourceSnapshot = { document: f.document, library, ownership, resolved, source: f.context.currentSource };
    // Precondition: the analysis route reads subassemblies from the snapshot library, which holds the welded child.
    expect(snapshot.library.assemblies?.get('welded-cell')).toBe(f.child);
    const prepared = prepareBeamAnalysis(snapshot, { ...f.definition, weldLayers: f.associations });
    expect(prepared.ok ? prepared.kind : prepared.issue.message).toBe('weld-contact');
    if (prepared.ok && prepared.kind === 'weld-contact') expect(prepared.input.welds).toHaveLength(2);
  });
});
