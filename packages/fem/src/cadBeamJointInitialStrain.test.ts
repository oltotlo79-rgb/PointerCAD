import { describe, expect, it } from 'vitest';
import { cadJointContactFixture } from '../../model/src/analysis/cadJointContact.testSupport.js';
import { prepareCadBeamJointInitialStrain } from './cadBeamJointInitialStrain.js';
import { prepareCadBeamJointContact } from './cadBeamJointContact.js';
import { prepareCadBeamBoltContact } from './cadBeamBoltContact.js';
import { prepareCadBeamWeldContact } from './cadBeamWeldContact.js';

describe('current CAD initial-strain association', () => {
  it('converts the explicit shortening once while retaining the actual shank and complete intermittent group', () => {
    const f = cadJointContactFixture(), before = structuredClone(f.document);
    const initialStrain = { schema: 'pointercad-cad-joint-initial-strain/1', shortenings: [{ boltId: 'mixed-shank', shorteningMm: .001,
      source: { kind: 'user-supplied', reference: 'prescribed stress-free length', condition: 'small-strain elastic reference state' } }] };
    const definition = { ...f.definition, initialStrain };
    const input = prepareCadBeamJointInitialStrain(f.document, definition, f.context);
    expect(input.shortenings).toEqual([{ boltId: 'mixed-shank', shorteningM: .000001 }]);
    expect(input.joint.welds.map(w => w.id)).toEqual(['effective-throat', 'effective-throat-1']);
    expect(f.document).toEqual(before);
    expect(() => prepareCadBeamJointContact(f.document, definition, f.axialBolts, f.associations, f.context)).toThrow('initial-strain');
    expect(() => prepareCadBeamBoltContact(f.document, definition, f.axialBolts, f.context)).toThrow('initial-strain');
    expect(() => prepareCadBeamWeldContact(f.document, definition, f.associations, f.context)).toThrow('initial-strain');
    for (const componentId of [f.axialBolts.bolts[0].boltComponentId, f.associations.welds[1].beadComponentId]) {
      const stale = { ...f.document, components: f.document.components.filter(c => c.id !== componentId) };
      expect(() => prepareCadBeamJointInitialStrain(stale, definition, f.context)).toThrow();
    }
    const tooShort = { ...definition, initialStrain: { ...initialStrain,
      shortenings: [{ ...initialStrain.shortenings[0], shorteningMm: 10 }] } };
    expect(() => prepareCadBeamJointInitialStrain(f.document, tooShort, f.context)).toThrow('initial-strain-stress-free-length');
  });
});
