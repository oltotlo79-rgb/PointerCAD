import { decodeBeamImpact, impactInputSha256, impactOutputSteps, translateBeamImpact, type BeamImpactInput,
  type BeamImpactResult, type FemWorkerPort, type ImpactMemberResponseSet } from '@pointercad/fem';
import type { StandardBeamFibreOutline } from '@pointercad/model/beam-analysis';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { requireBeamSession } from './beam.testSupport.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { fibreOutlinesFromDraft } from './beamImpactDraft.js';
import { BeamImpactResults } from './BeamImpactResults.js';
import { beamDisplayNumber } from './BeamResults.js';
import { beamDefinition, editBeamSession, restoreBeamSession, type BeamEdit, type BeamSession } from './beamSession.js';

// task185: the explicit section outline through the public path (impact form edit, saved definition, reopen) and the
// nominal fibre stress shown for an accepted result. The reply is a PROTOCOL fixture built with this test's own
// closed-form Euler-Bernoulli block (not a native result); expectations are textbook M c / I numbers.
type Vector3 = readonly [number, number, number];
class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
}
let attachment: BeamAttachment | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; resetTestStore(); });

/** Solid rectangle 20 mm along y by 40 mm along z: A = 800 mm2, Iy = 20 * 40^3 / 12, Iz = 40 * 20^3 / 12 (mm4). */
const IY_MM4 = 20 * 40 ** 3 / 12, IZ_MM4 = 40 * 20 ** 3 / 12;
function impactSession(outline: (memberId: string) => readonly BeamEdit[]): {
  readonly fixture: ReturnType<typeof contactUiFixture>; readonly session: BeamSession;
} {
  const fixture = contactUiFixture();
  const id = fixture.member.id;
  const edits: readonly BeamEdit[] = [
    { kind: 'analysis-type', value: 'impact' },
    { kind: 'value', id, field: 'endFz', source: '0' },
    { kind: 'value', id, field: 'area', source: '800' },
    { kind: 'value', id, field: 'iy', source: String(IY_MM4) },
    { kind: 'value', id, field: 'iz', source: String(IZ_MM4) },
    { kind: 'contact-value', index: 0, field: 'normalZ', source: '-2' },
    { kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-2' },
    { kind: 'impact-value', field: 'contactStiffness', source: '10000000' },
    { kind: 'impact-value', field: 'timeStep', source: '0.01ms' },
    { kind: 'impact-value', field: 'stepCount', source: '200' },
    { kind: 'impact-value', field: 'outputEvery', source: '2' },
    ...outline(id),
  ];
  return { fixture, session: edits.reduce(editBeamSession, fixture.session) };
}
const rectangle = (id: string, width = '20', depth = '40'): BeamEdit[] => [
  { kind: 'impact-fibre', memberId: id, field: 'kind', source: 'rectangle' },
  { kind: 'impact-fibre', memberId: id, field: 'first', source: width },
  { kind: 'impact-fibre', memberId: id, field: 'second', source: depth },
];
async function running(outline: (id: string) => readonly BeamEdit[]) {
  const { fixture, session } = impactSession(outline);
  const ports: Port[] = [];
  useAppStore.setState({ ...fixture.state, beamSession: session });
  attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  useAppStore.getState().reviewBeam();
  expect(requireBeamSession().errorKey).toBeNull();
  useAppStore.getState().runBeam();
  await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
  const port = ports[0], request = port.request;
  if (request?.kind !== 'analyze-beam-impact-3d') throw new Error('Expected an impact request');
  return { fixture, port, request, input: request.input };
}
function constants(input: BeamImpactInput) {
  const scale = input.geometry.units === 'N-mm' ? 0.001 : 1;
  const [member] = input.geometry.members;
  const material = input.geometry.materials.find(row => row.id === member.materialId);
  const section = input.geometry.sections.find(row => row.id === member.sectionId);
  if (material === undefined || section === undefined) throw new Error('missing material or section');
  return { youngPa: material.youngModulus / scale ** 2, areaM2: section.area * scale ** 2,
    iyM4: section.iy * scale ** 4, izM4: section.iz * scale ** 4 };
}
function block(frame: { readonly x: Vector3; readonly y: Vector3; readonly z: Vector3 }, length: number,
  c: ReturnType<typeof constants>): number[][] {
  const k = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
  const put = (i: number, j: number, value: number): void => { k[i][j] += value; if (i !== j) k[j][i] += value; };
  const axial = c.youngPa * c.areaM2 / length;
  put(0, 0, axial); put(6, 6, axial); put(0, 6, -axial);
  put(3, 3, 1); put(9, 9, 1); put(3, 9, -1);
  for (const [v, t, inertia, sign] of [[1, 5, c.izM4, 1], [2, 4, c.iyM4, -1]] as const) {
    const e = c.youngPa * inertia / length ** 3;
    put(v, v, 12 * e); put(v + 6, v + 6, 12 * e); put(v, v + 6, -12 * e);
    put(t, t, 4 * e * length ** 2); put(t + 6, t + 6, 4 * e * length ** 2); put(t, t + 6, 2 * e * length ** 2);
    put(v, t, sign * 6 * e * length); put(v, t + 6, sign * 6 * e * length);
    put(v + 6, t, -sign * 6 * e * length); put(v + 6, t + 6, -sign * 6 * e * length);
  }
  const r = [frame.x, frame.y, frame.z];
  const rot = (i: number, j: number): number => Math.floor(i / 3) === Math.floor(j / 3) ? r[i % 3][j % 3] : 0;
  return k.map((_, i) => k.map((__, j) => {
    let sum = 0;
    for (let p = 0; p < 12; p += 1) for (let q = 0; q < 12; q += 1) sum += rot(p, i) * k[p][q] * rot(q, j);
    return sum;
  }));
}
/** Double curvature (guided far end) along local y; `mesh` false gives the old reply format. */
async function guidedReply(source: BeamImpactInput, delta: number, mesh: boolean): Promise<BeamImpactResult> {
  const { plan } = translateBeamImpact(source);
  const h = plan.impact.timeStepS;
  const { y, z } = plan.members[0].frame;
  // The clamped member start is the origin of s, not plan.nodes[0]: plan nodes are numbered by sorted id, so
  // '<member>-end' precedes '<member>-start' and plan.nodes[0] is the free end (task043, ui-batch-1).
  const clamped = plan.nodes[plan.members[0].nodes[0] - 1];
  if (!clamped.restrained.every(Boolean)) throw new Error('fixture: the member start must be the clamped support');
  const start = clamped.positionM;
  const total = plan.members.reduce((sum, member) => sum + member.frame.lengthM, 0);
  const state = (index: number, step: number): { u: Vector3; theta: Vector3 } => {
    if (step === 0) return { u: [0, 0, 0], theta: [0, 0, 0] };
    const p = plan.nodes[index].positionM;
    const s = Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]);
    const v = delta * (3 * s * s * total - 2 * s ** 3) / total ** 3, theta = 6 * delta * (s * total - s * s) / total ** 3;
    return { u: [v * y[0], v * y[1], v * y[2]], theta: [theta * z[0], theta * z[1], theta * z[2]] };
  };
  const c = constants(source);
  const samples = impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery).map(step => ({
    step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
    nodes: plan.nodes.slice(0, plan.originalNodeCount).map((node, index) => ({ number: node.number,
      displacementM: state(index, step).u, rotationRad: state(index, step).theta,
      velocityMPerS: step === 0 ? plan.impact.initialVelocity[index].slice(0, 3) : [0, 0, 0], angularVelocityRadPerS: [0, 0, 0] })),
    contacts: plan.impact.contacts.map(contact => {
      const u = state(contact.node - 1, step).u;
      return { gapM: contact.gapM - (contact.directionUnit[0] * u[0] + contact.directionUnit[1] * u[1] + contact.directionUnit[2] * u[2]),
        intervalForceN: step === 0 ? null : 0, impulseNs: step === 0 ? null : 0 };
    }),
    ...(mesh ? { mesh: plan.nodes.map((node, index) => ({ number: node.number, displacementM: state(index, step).u,
      rotationRad: state(index, step).theta })) } : {}),
  }));
  // Independent support proof of this fixture (not the decoder): every restrained DOF of every plan node is 0.
  for (const step of impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery)) {
    plan.nodes.forEach((node, index) => {
      const { u, theta } = state(index, step);
      const values = [...u, ...theta];
      if (node.restrained.some((fixed, axis) => fixed && values[axis] !== 0)) throw new Error('fixture: displaced support');
    });
  }
  return decodeBeamImpact({
    schema: 'pointercad-oofem-impact-result/1', samples,
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 0, maximumMomentumResidual: 0, factorizationsUsed: 1,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 0, timeS: h, totalImpulseNs: 0 })),
    ...(mesh ? { elements: plan.members.map(member => ({ number: member.number, nodes: [...member.nodes],
      globalStiffness: block(member.frame, member.frame.lengthM, c) })) } : {}),
  }, source, await impactInputSha256(source));
}
const resultEvent = (request: { readonly protocol: unknown; readonly identity: unknown }, result: BeamImpactResult) =>
  new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } });
/** The panel's own inputs: the outline text parsed for the current members (BeamPanel uses the same call). */
function view(session: BeamSession): string {
  if (session.result?.kind !== 'oofem-beam-impact-3d') throw new Error('Expected an impact result');
  const outlines = fibreOutlinesFromDraft(session.impact, session.members.map(member => member.id), []);
  return renderToStaticMarkup(createElement(BeamImpactResults, { result: session.result, members: session.impactMembers,
    outlines: outlines.ok ? outlines.outlines : null }));
}

describe('explicit section outline: saved definition and reopen', () => {
  it('saves the outline under the member section id, keeps it out of the solver input and restores the text', async () => {
    const { request, input } = await running(id => rectangle(id));
    const session = requireBeamSession();
    if (session.reviewed === null) throw new Error('Expected a reviewed source');
    const checked = beamDefinition(session, session.reviewed, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/6') throw new Error('Expected an impact definition');
    const memberId = session.members[0].id;
    expect(checked.definition.impact.fibreSections).toEqual([
      { sectionId: `${memberId}-section`, outline: { kind: 'rectangle', widthYMm: 20, depthZMm: 40 } }]);
    // The solver input has no outline field: post-processing only.
    expect(JSON.stringify(request.input)).not.toContain('fibre');
    expect(input.geometry.sections[0].area).toBe(800);
    const reopened = restoreBeamSession(session.ownerId, checked.definition, []);
    expect(reopened.impact.fibreSections).toEqual({ [memberId]: { kind: 'rectangle', first: '20', second: '40' } });
  });
});

describe('nominal fibre stress of an accepted result', () => {
  it('double curvature: +-6EIzd/L^2 at the ends gives the corner stress M c / Iz with tension at -y, zero member mean', async () => {
    const { port, request, input } = await running(id => rectangle(id));
    const delta = 1e-4;
    port.onmessage?.(resultEvent(request, await guidedReply(input, delta, true)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const session = requireBeamSession();
    if (session.result?.kind !== 'oofem-beam-impact-3d') throw new Error('Expected an impact result');
    if (session.impactMembers === null) throw new Error('Expected the bound member set');
    session.impactMembers.members[0].meanMomentZNm.values.forEach(value => expect(Math.abs(value)).toBe(0));
    const { plan } = translateBeamImpact(input);
    const length = plan.members.reduce((sum, member) => sum + member.frame.lengthM, 0);
    const c = constants(input);
    const moment = 6 * c.youngPa * c.izM4 * delta / length ** 2;
    const stressMPa = moment * 0.010 / c.izM4 / 1e6;
    const html = view(session);
    const row = html.split('<tr').find(part => part.includes('data-beam-impact-fibre-element="1"')
      && part.includes('data-beam-impact-fibre-end="start"'));
    expect(row).toContain(`${beamDisplayNumber(stressMPa)} MPa (y ${beamDisplayNumber(-10)} mm`);
    expect(row).toContain(`${beamDisplayNumber(-stressMPa)} MPa (y ${beamDisplayNumber(10)} mm`);
    expect(html).toContain(`${beamDisplayNumber(session.result.samples[1].timeS * 1000)} ms`);
    expect(html).toContain('data-beam-impact-yield="data-missing"');
    expect(html).toContain('data-testid="beam-impact-fibre-limits"');
    expect(html.indexOf('data-testid="beam-impact-strength-not-assessed"'))
      .toBeLessThan(html.indexOf('data-testid="beam-impact-fibre-stress"'));
  });

  it.each([
    ['missing', (): readonly BeamEdit[] => []],
    ['inconsistent', (id: string): readonly BeamEdit[] => rectangle(id, '20', '41')],
  ] as const)('a %s outline gives a typed status and no stress number', async (status, outline) => {
    const { port, request, input } = await running(outline);
    port.onmessage?.(resultEvent(request, await guidedReply(input, 1e-4, true)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const html = view(requireBeamSession());
    expect(html).toContain(`data-beam-impact-fibre-status="${status}"`);
    expect(html).not.toContain('data-beam-impact-fibre-element=');
  });

  it('an old-format reply shows no fibre stress at all', async () => {
    const { port, request, input } = await running(id => rectangle(id));
    port.onmessage?.(resultEvent(request, await guidedReply(input, 1e-4, false)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    expect(view(requireBeamSession())).not.toContain('beam-impact-fibre-stress');
  });

  it('an outline edit after completion clears the result, so no stale stress can be shown', async () => {
    const { port, request, input, fixture } = await running(id => rectangle(id));
    port.onmessage?.(resultEvent(request, await guidedReply(input, 1e-4, true)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    useAppStore.getState().editBeam({ kind: 'impact-fibre', memberId: fixture.member.id, field: 'second', source: '50' });
    expect(requireBeamSession().result).toBeNull();
  });

  // task042: the member-mean unassessed list names bending fibre stress unless the section above really holds
  // evaluated numbers for every bound member; every other unassessed quantity always stays listed.
  const unassessed = (html: string): string[] =>
    [...html.matchAll(/data-beam-impact-unassessed="([^"]+)"/gu)].map(match => match[1]);
  const KEPT = ['torsional-shear-stress', 'transverse-shear', 'combined-or-equivalent-stress', 'yield-check'];
  async function completed(outline: (id: string) => readonly BeamEdit[], mesh = true): Promise<BeamSession> {
    const { port, request, input } = await running(outline);
    port.onmessage?.(resultEvent(request, await guidedReply(input, 1e-4, mesh)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    return requireBeamSession();
  }
  function bound(session: BeamSession): {
    readonly members: ImpactMemberResponseSet; readonly outlines: ReadonlyMap<string, StandardBeamFibreOutline>;
  } {
    const outlines = fibreOutlinesFromDraft(session.impact, session.members.map(member => member.id), []);
    if (session.impactMembers === null || !outlines.ok) throw new Error('Expected the bound member set and outlines');
    return { members: session.impactMembers, outlines: outlines.outlines };
  }
  function render(session: BeamSession, members: ImpactMemberResponseSet,
    outlines: ReadonlyMap<string, StandardBeamFibreOutline>): string {
    if (session.result?.kind !== 'oofem-beam-impact-3d') throw new Error('Expected an impact result');
    return renderToStaticMarkup(createElement(BeamImpactResults, { result: session.result, members, outlines }));
  }

  it('all members supported with evaluated element ends: only the bending-fibre row is replaced', async () => {
    const html = view(await completed(id => rectangle(id)));
    expect(html).toContain('data-beam-impact-fibre-element="1"');
    expect(unassessed(html)).not.toContain('bending-fibre-stress');
    expect(unassessed(html)).not.toContain('end-and-interior-section-forces');
    for (const key of KEPT) expect(unassessed(html)).toContain(key);
  });

  it.each([
    ['missing', (): readonly BeamEdit[] => []],
    ['inconsistent', (id: string): readonly BeamEdit[] => rectangle(id, '20', '41')],
  ] as const)('a %s outline keeps the bending-fibre row', async (status, outline) => {
    const html = view(await completed(outline));
    expect(html).toContain(`data-beam-impact-fibre-status="${status}"`);
    expect(html).not.toContain('data-beam-impact-fibre-element=');
    expect(unassessed(html)).toContain('bending-fibre-stress');
    for (const key of KEPT) expect(unassessed(html)).toContain(key);
  });

  it('an old-format reply keeps the bending-fibre and end-force rows', async () => {
    const html = view(await completed(id => rectangle(id), false));
    expect(html).not.toContain('data-testid="beam-impact-fibre-stress"');
    expect(unassessed(html)).toEqual(expect.arrayContaining(['end-and-interior-section-forces', 'bending-fibre-stress', ...KEPT]));
  });

  it('a supported member next to a member without an outline keeps the row (mixed)', async () => {
    const session = await completed(id => rectangle(id));
    const { members, outlines } = bound(session);
    const mixed = { ...members, members: [...members.members, { ...members.members[0], memberId: 'second-member' }] };
    const html = render(session, mixed, outlines);
    expect(html).toContain('data-beam-impact-fibre-element="1"');
    expect(html).toContain('data-beam-impact-fibre-member="second-member"');
    expect(html).toContain('data-beam-impact-fibre-status="missing"');
    expect(unassessed(html)).toContain('bending-fibre-stress');
    for (const key of KEPT) expect(unassessed(html)).toContain(key);
  });

  it('a supported outline without element rows of this result, or an empty member set, claims no stress', async () => {
    const session = await completed(id => rectangle(id));
    const { members, outlines } = bound(session);
    const [member] = members.members;
    const outline = outlines.get(member.memberId);
    if (outline === undefined) throw new Error('Expected the entered outline');
    // Same nodes and series, but a member id with no element in this result: the outline is supported, no end is evaluated.
    const html = render(session, { ...members, members: [{ ...member, memberId: 'not-in-result' }] },
      new Map([['not-in-result', outline]]));
    expect(html).toContain('data-testid="beam-impact-fibre-stress"');
    expect(html).not.toContain('data-beam-impact-fibre-element=');
    expect(unassessed(html)).toContain('bending-fibre-stress');
    const empty = render(session, { ...members, members: [] }, outlines);
    expect(empty).not.toContain('data-beam-impact-fibre-element=');
    expect(unassessed(empty)).toContain('bending-fibre-stress');
    for (const key of KEPT) expect(unassessed(empty)).toContain(key);
  });
});
