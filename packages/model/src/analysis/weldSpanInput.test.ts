import { describe, expect, it } from 'vitest';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import { readBeamAnalysisInputs } from './beamInputs.js';
import { readCadWeldLayerInputs } from './weldLayerInput.js';
import { readCadWeldSpanInputs, readSavedCadWeldInputs } from './weldSpanInput.js';

function fixture() {
  const f = cadWeldLayerFixture();
  const welds = f.associations.welds.map(w => ({ ...w,
    first: { kind: 'section-node' as const, ...w.first }, second: { kind: 'member-span' as const, memberId: w.second.memberId } }));
  return { ...f, v2: { ...f.associations, schema: 'pointercad-cad-weld-layers/2' as const, welds } };
}
function attachment(definition: unknown) { return { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] }; }

describe('saved weld span version 2 input', () => {
  it('retains old version and both explicitly typed sides in the current owner', () => {
    const f = fixture(), saved = { ...f.definition, weldLayers: f.v2 };
    expect(readCadWeldLayerInputs(f.associations)).toEqual(f.associations);
    expect(() => readCadWeldLayerInputs(f.v2)).toThrow();
    expect(readCadWeldSpanInputs(f.v2)).toEqual(f.v2);
    expect(readSavedCadWeldInputs(f.v2)).toEqual(f.v2);
    const parsed = readBeamAnalysisInputs(attachment(saved), f.document.id);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.issue.message);
    expect(parsed.value.analyses[0]).toEqual({ kind: 'standard-members', definition: saved });
  });
  it('refuses missing or foreign owner, endpoint, revision and source', () => {
    const f = fixture(), w = f.v2.welds[0];
    for (const invalid of [
      { ...f.v2, analysisRevision: f.v2.analysisRevision + 1 },
      { ...f.v2, source: { ...f.v2.source, documentId: 'foreign' } },
      { ...f.v2, welds: [{ ...w, first: { ...w.first, nodeId: 'foreign' } }] },
      { ...f.v2, welds: [{ ...w, second: { ...w.second, memberId: 'foreign' } }] },
    ]) {
      const parsed = readBeamAnalysisInputs(attachment({ ...f.definition, weldLayers: invalid }), f.document.id);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(['weld-stale', 'weld-owner']).toContain(parsed.issue.code);
    }
  });
  it('rejects unknown schema/kinds/keys, self connections, repeated beads and unsupported size', () => {
    const { v2 } = fixture(), w = v2.welds[0];
    for (const invalid of [
      { ...v2, schema: 'pointercad-cad-weld-layers/3' },
      { ...v2, welds: [{ ...w, first: { kind: 'unknown', memberId: w.first.memberId } }] },
      { ...v2, welds: [{ ...w, second: { ...w.second, nodeId: 'extra' } }] },
      { ...v2, welds: [{ ...w, first: { kind: 'section-node', memberId: w.first.memberId } }] },
      { ...v2, welds: [{ ...w, second: { ...w.second, memberId: w.first.memberId } }] },
      { ...v2, welds: [w, { ...w, id: 'another' }] },
      { ...v2, welds: Array.from({ length: 65 }, () => w) },
      { ...v2, welds: [{ ...w, youngMPa: Number.NaN }] },
    ]) expect(() => readSavedCadWeldInputs(invalid)).toThrow();
    expect(() => readCadWeldSpanInputs({ ...v2, welds: Array(1) })).toThrow();
    const getter = structuredClone(v2);
    Object.defineProperty(getter.welds[0], 'youngMPa', { get: () => { throw new Error('getter executed'); }, enumerable: true });
    expect(() => readCadWeldSpanInputs(getter)).toThrow('Plain dense');
  });
});
