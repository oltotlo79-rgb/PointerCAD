import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { beamWeldSpanContactInputSha256, decodeBeamWeldSpanContact, recoverBeamWeldSpanStress,
  type BeamWeldSpanContactInput, type BeamWeldSpanStressResult } from '@pointercad/fem';
import { modalFixture } from '../../../fem/src/modal.testSupport.js';
import { t } from '../i18n/t.js';
import { WeldSpanResultTable } from './BeamWeldSpanResults.js';
import { currentWeldSpanStress, startWeldSpanStressRecovery, WeldSpanStressTable, WeldSpanStressView } from './BeamWeldSpanStressResults.js';

/** Independent integral K/C fractions: one-element K=500,C=4000/3; two-element axial 2x2 integrals.
 * This is a pure decoder/view fixture, not an executed native solve or a CAD result. */
async function resultFixture(segments: 1 | 2) {
  const base = modalFixture({ free: true, modes: 1, segments });
  const input: BeamWeldSpanContactInput = { schema: 'pointercad-weld-span/1', contact: {
    schema: 'pointercad-beam-contact/1', geometry: { ...base,
      nodes: [0, 2, 0, 2].map((x, i) => ({ id: `n${i}`, position: [x, 0, 0] })),
      members: ['a', 'b'].map((id, i) => ({ ...base.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `n${2*i}`, endNodeId: `n${2*i+1}` })),
      materials: [{ ...base.materials[0], youngModulus: 1000, shearModulus: 400, densityKgM3: 1 }],
      sections: [{ ...base.sections[0], area: 1, iy: .1, iz: .1, torsionConstant: .1, shearFactor: 1 }] },
    supports: [0, 1, 2, 3].map(i => ({ nodeId: `n${i}`, restrained: [i%2 === 0, true, true, true, true, true] })),
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'n3', force: [1, 0, 0], moment: [0, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'n3', normal: [-1, 0, 0], gapM: .01 }], loadFactors: [1, 0, -1] },
    patches: [{ id: 'layer', centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
      thicknessM: .2, youngPa: 1000, poisson: .25, first: { kind: 'member-span', memberId: 'a' },
      second: { kind: 'member-span', memberId: 'b' } }] };
  const u = segments === 1 ? [0, 8/9500, 0, 11/9500] : [0, 76/97000, 0, 118/97000, 47/97000, 50/97000];
  const first = segments === 1 ? [4/19, 8/19, 0, 0] : [1/97, 29/97, 0, 0, 18/97, 0];
  const second = segments === 1 ? [0, 0, -4/19, -8/19] : [0, 0, -1/97, -29/97, 0, -18/97];
  const states = [1, 0, -1].map(f => ({ loadFactor: f,
    meshNodes: u.map((x, i) => ({ number: i+1, displacementM: [x*f, 0, 0], rotationRad: [0, 0, 0] })),
    welds: [{ id: 'layer', first: first.map(x => [x*f, 0, 0, 0, 0, 0]), second: second.map(x => [x*f, 0, 0, 0, 0, 0]),
      forceOnFirstN: [(segments === 1 ? 12/19 : 48/97)*f, 0, 0], momentAtCenterNm: [0, 0, 0],
      energyJ: (segments === 1 ? 3/45125 : 159/2352250)*f*f, structuralCertification: false }] }));
  const raw = { schema: 'pointercad-weld-span-result/1', contact: {
    schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
    freeDofs: segments === 1 ? 2 : 14, meshNodes: u.length, meshElements: 2*segments,
    momentLengthM: 2/segments, pivotLimit: 20,
    states: states.map(s => ({ loadFactor: s.loadFactor, pivots: 0, forceScaleN: 1, gapScaleM: .01,
      equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0, nodes: s.meshNodes.slice(0, 4),
      contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .01-u[3]*s.loadFactor }] })) }, states };
  const hash = await beamWeldSpanContactInputSha256(input);
  return { input, hash, result: await decodeBeamWeldSpanContact(raw, input, hash) };
}

/** Explicit presentation values: 2 MPa, -3 MPa, 4 MPa and positions 250/500/-125 mm.
 * Display-only data, not a claimed solution or native run. Actual input-bound recovery is tested separately below. */
function displayStress(): BeamWeldSpanStressResult {
  return { inputSha256: 'a'.repeat(64), structuralCertification: false, states: [1, 0, -1].map(factor => ({
    loadFactor: factor, welds: [{ id: 'bead-A', sampling: 'gauss-4x2-per-cell', structuralCertification: false,
      points: [{ positionM: [.25, .5, -.125], areaWeightM2: .125,
      relativeDisplacementM: [0, 0, 0], normalPa: 2e6*factor, shearAlongPa: -3e6*factor, shearAcrossPa: 4e6*factor }] }],
  })) };
}

describe('current long-weld integration point stress display', () => {
  it.each([0, 1, 2])('preserves Pa, exact MPa conversion, actual positions and only selected factor index %i', index => {
    const factor = [1, 0, -1][index];
    const markup = renderToStaticMarkup(<WeldSpanStressTable stress={displayStress()} state={index} />);
    expect(markup).toContain(`data-load-factor="${factor}"`);
    expect(markup).toContain('data-structural-certification="false"');
    expect(markup).toContain('data-weld-span="bead-A"');
    expect(markup).toContain('data-unit="m" data-value="0.25">250</td>');
    expect(markup).toContain('data-unit="m" data-value="0.5">500</td>');
    expect(markup).toContain('data-unit="m" data-value="-0.125">-125</td>');
    for (const [quantity, pascals, mpa] of [['normalPa', 2000000, 2], ['shearAlongPa', -3000000, -3], ['shearAcrossPa', 4000000, 4]] as const) {
      expect(markup).toContain(`data-stress="${quantity}" data-unit="Pa" data-value="${pascals*factor}">${mpa*factor}</td>`);
    }
    expect(markup.match(/data-point=/gu)).toHaveLength(1);
    expect(markup).toContain('<details'); expect(markup).toContain('<summary>');
    expect(markup).toContain(t('beam.weldSpanStressTitle'));
    expect(markup).toContain(t('beam.weldSpanStressScope'));
  });

  it('runs the real input-bound recovery before showing actual samples alongside unchanged force/energy tables', async () => {
    const f = await resultFixture(1), stress = await recoverBeamWeldSpanStress(f.input, f.result);
    const x = 1 - Math.sqrt((3 - 2*Math.sqrt(6/5))/7); // Independent first four-point Gauss abscissa on [0,2].
    for (const [index, factor] of [1, 0, -1].entries()) {
      const point = stress.states[index].welds[0].points[0];
      expect(point.positionM[0]).toBeCloseTo(x, 14);
      // G/t=400/.2=2000; axial relative displacement is 3*x/19000 metres.
      expect(point.shearAlongPa).toBeCloseTo(2000*3*x/19000*factor, 12);
      expect(point.normalPa).toBe(0);
      const markup = renderToStaticMarkup(<><WeldSpanResultTable result={f.result} view={{ state: index }} />
        <WeldSpanStressTable stress={stress} state={index} /></>);
      expect(markup).toContain('data-testid="beam-weld-span-wrenches"');
      expect(markup).toContain('data-testid="beam-weld-span-nodal-loads"');
      expect(markup).toContain(`data-unit="N" data-value="${12/19*factor}"`);
      expect(markup).toContain(`data-unit="J" data-value="${3/45125*factor*factor}"`);
      expect(markup.match(/data-point=/gu)).toHaveLength(8);
      expect(markup).toContain(`data-unit="m" data-value="${point.positionM[0]}"`);
    }
  });

  it.each(['owner', 'input', 'result'] as const)('does not display a delayed %s reply even before passive effect cleanup', async change => {
    const f = await resultFixture(1), request = { input: f.input, result: f.result, owner: 'opening:analysis:revision1' };
    type Completion = NonNullable<Parameters<typeof currentWeldSpanStress>[0]>;
    let resolve: ((value: BeamWeldSpanStressResult) => void) | undefined;
    const delivered: Completion[] = [];
    startWeldSpanStressRecovery(request, value => delivered.push(value), () => new Promise(r => { resolve = r; }));
    if (resolve === undefined) throw new Error('Recovery did not start');
    const next = change === 'owner' ? { ...request, owner: 'opening:analysis:revision2' }
      : change === 'input' ? { ...request, input: structuredClone(request.input) }
      : { ...request, result: structuredClone(request.result) };
    resolve(displayStress()); await Promise.resolve();
    expect(delivered).toHaveLength(1);
    expect(currentWeldSpanStress(delivered[0], next)).toBeNull();
    const markup = renderToStaticMarkup(<WeldSpanStressView completion={delivered[0]} request={next} state={0} />);
    expect(markup).toContain('role="status"'); expect(markup).not.toContain('data-stress=');
  });

  it.each([false, true])('effect cleanup drops a late success/rejection (reject=%s)', async reject => {
    const f = await resultFixture(1), publish = vi.fn();
    let finish: (() => void) | undefined;
    const cleanup = startWeldSpanStressRecovery({ input: f.input, result: f.result, owner: 'opening' }, publish,
      () => new Promise((resolve, fail) => { finish = () => reject ? fail(new Error('late')) : resolve(displayStress()); }));
    cleanup(); if (finish === undefined) throw new Error('Deferred recovery required'); finish();
    await Promise.resolve(); expect(publish).not.toHaveBeenCalled();
  });

  it('shows re-review instead of zero stress when the actual API rejects a changed input', async () => {
    const f = await resultFixture(1), request = { input: { ...f.input,
      patches: f.input.patches.map(p => ({ ...p, thicknessM: .3 })) }, result: f.result, owner: 'opening' };
    const delivered: NonNullable<Parameters<typeof currentWeldSpanStress>[0]>[] = [];
    startWeldSpanStressRecovery(request, value => delivered.push(value));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].stress).toBeNull();
    const markup = renderToStaticMarkup(<WeldSpanStressView completion={delivered[0]} request={request} state={0} />);
    expect(markup).toContain('role="alert"'); expect(markup).toContain(t('beam.error.review'));
    expect(markup).not.toContain('data-stress=');
  });
});
