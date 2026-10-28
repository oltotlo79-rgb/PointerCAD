import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beamImpactResultMatches } from './beamImpactBinding.js';
import {
  checkFibreSection, compareWithYield, elementFibreStresses, type AnalysedSection, type BeamFibreSection,
} from './beamFibreStress.js';
import { impactElementEndForces, type BeamImpactInterior } from './beamImpactInterior.js';
import { impactMemberResponse } from './beamImpactMemberResponse.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { decodeBeamImpact } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

// task040: the exact stdout record of the unchanged harness beamImpactNativeInterior.harness.mjs/.test.py, run with
// a pinned node on the generated producer beamImpact.py 25aa6572 with beamAnalysis.py 9593ec53 (capture_r41,
// then materialize_r41: the capture_r40 record re-taken after beamAnalysis.py changed). It proves only
// those bytes: the first test fails as soon as the producer, harness or a runtime asset pin differs, and a new capture
// is then required. The earlier producer's record (beamImpactNativeFixture.json, program 5ba11f6e) is separate and
// unchanged. Every expectation comes from the explicit SI input numbers in `constants` and closed-form mechanics
// derived here (N, m, Pa), never from the functions under test.
const FIXTURE_SHA256 = '773e3d0877b9d3ba643d4707f6bcf8ed913ca3f86414eb62588cb1bb68aacc4b';
const fixtureBytes = readFileSync(new URL('./fixtures/beamImpactNativeCurrentFixture.json', import.meta.url));
const parsedFixture: unknown = JSON.parse(fixtureBytes.toString('utf8'));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('current native fixture record');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('current native fixture array');
  return value;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('current native fixture number');
  return value;
}
function numbers(value: unknown, length: number): number[] {
  const items = array(value).map(numeric);
  if (items.length !== length) throw new Error('current native fixture vector length');
  return items;
}
function vector3(value: unknown): [number, number, number] {
  const [x, y, z] = numbers(value, 3);
  return [x, y, z];
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fileSha = (relative: string): string => digest(readFileSync(new URL(relative, import.meta.url)));

const fixture = record(parsedFixture);
const provenance = record(fixture.provenance);
const constants = record(fixture.constants);
const YOUNG = numeric(constants.youngPa);
const SHEAR = numeric(constants.shearPa);
const AREA = numeric(constants.areaM2);
const IY = numeric(constants.iyM4);
const IZ = numeric(constants.izM4);
const WIDTH_Y = numeric(constants.widthYM);
const DEPTH_Z = numeric(constants.depthZM);
const SEGMENTS = numeric(constants.segments);
const START = vector3(constants.startM);
const END = vector3(constants.endM);
const LENGTH = Math.hypot(END[0] - START[0], END[1] - START[1], END[2] - START[2]);
const SEGMENT_LENGTH = LENGTH / SEGMENTS;
const historyRow = record(constants.history);
const HISTORY = { timeStepS: numeric(historyRow.timeStepS), stepCount: numeric(historyRow.stepCount),
  outputEvery: numeric(historyRow.outputEvery) };
/** Steps 0, outputEvery, ... and the last step. */
const SAMPLE_COUNT = Math.ceil(HISTORY.stepCount / HISTORY.outputEvery) + 1;
/** beamImpactNativeInterior.test.ts: 10 fixed checks, 2 per element and 2 original-node rows per sample. */
const HARNESS_CHECKS = 10 + 2 * SEGMENTS + 2 * SAMPLE_COUNT;
interface OracleRow { readonly start: number[]; readonly end: number[] }
/** Closed-form Timoshenko section resultants [N, Vy, Vz, T, My, Mz] (N, N m) per sample and element, computed by the
 * harness oracle from the mesh response with its own element formula, not by the product. */
const ORACLE: OracleRow[][] = array(fixture.closedFormOracle).map(rows => array(rows).map(row => {
  const item = record(row);
  return { start: numbers(item.start, 6), end: numbers(item.end, 6) };
}));
const PEAK = Math.max(...ORACLE.flat().flatMap(row => [...row.start, ...row.end].map(Math.abs)));

const evidence = { kind: 'user-supplied', reference: 'Explicit axis-aligned rectangular cantilever constants (task040)',
  condition: 'Isotropic elastic constants and a solid rectangle outline for beam-formula checks; no yield, capacity or general impact claim' } as const;
function currentInput(): BeamImpactInput {
  return {
    schema: 'pointercad-beam-impact/1',
    geometry: {
      schema: 'pointercad-beam/2', id: 'native-current-impact', revision: 1,
      source: { documentId: 'native-current-benchmark', documentRevision: 1, geometryRevision: 'explicit-two-metre-rectangle' },
      units: 'N-m', modal: { modeCount: 1, segmentsPerMember: SEGMENTS },
      nodes: [{ id: 'beam-a', position: vector3(constants.startM) }, { id: 'beam-b', position: vector3(constants.endM) }],
      members: [{ id: 'current-member', componentId: 'current-component', occurrencePath: ['current-component'],
        startNodeId: 'beam-a', endNodeId: 'beam-b', materialId: 'steel', sectionId: 'rectangle-section',
        localYHint: vector3(constants.localYHint) }],
      materials: [{ id: 'steel', youngModulus: YOUNG, shearModulus: SHEAR, densityKgM3: numeric(constants.densityKgM3),
        source: evidence }],
      sections: [{ id: 'rectangle-section', area: AREA, iy: IY, iz: IZ, torsionConstant: numeric(constants.torsionM4),
        shearFactor: numeric(constants.shearFactor), source: evidence }],
      constraints: [], loads: [],
    },
    supports: [{ nodeId: 'beam-a', restrained: [true, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'beam-b', velocityMPerS: vector3(constants.tipVelocityMPerS) }],
    contacts: [{ nodeId: 'beam-b', directionUnit: vector3(constants.contactDirectionUnit), gapM: numeric(constants.contactGapM) }],
    contactStiffnessNPerM: numeric(constants.contactStiffnessNPerM),
    history: { ...HISTORY },
  };
}
async function decoded(): Promise<{ readonly input: BeamImpactInput; readonly hash: string; readonly result: BeamImpactResult }> {
  const input = currentInput();
  const hash = await impactInputSha256(input);
  return { input, hash, result: decodeBeamImpact(fixture.result, input, hash) };
}
function interior(result: BeamImpactResult): BeamImpactInterior {
  if (result.interior === undefined) throw new Error('the captured reply must carry the mesh fields');
  return result.interior;
}

describe('current generated impact producer, captured natively: statics, extrema and combined normal stress', () => {
  it('pins the captured bytes to the exact current producer, harness and runtime pins', () => {
    expect(digest(fixtureBytes)).toBe(FIXTURE_SHA256);
    expect(fixture.schema).toBe('pcad-native-impact-current-fixture/1');
    expect(provenance.programSha256).toEqual({
      impact: '25aa6572c4dcd9891f5321151e02bc05c8eb2132e3233872f093cdf6fa6254a4',
      analysis: '9593ec530550d81c5ee46a824cafc9a3dedd0e68114c8371a0013e30ceec3a38',
      runtime: 'c83e8b7db908f2f521207b33ee0226d85065a284410da93b14a6e5b2b4ac15ef',
      harness: 'b82054b78287ba493ce9ad68dd033546adcccaf060ce09e214e547424e352cee',
      oracle: '0727673850881217d48ceb2bdce1d4ae1a75dc036c91d0cf81381e8d1c2ac34c',
    });
    expect(provenance.generationReceiptSha256).toBe('086f86b103755f52d7756e641c50ff1bf7546af1382de37211db2157b19d8d81');
    expect(provenance.runtimeManifestSha256).toBe('89efa2401e62c5c2c09d49d501bd0421e08a139a64ff54ec12b0f7c402af74ac');
    for (const key of ['nodeSha256', 'captureReceiptSha256', 'captureInputSha256', 'stdoutSha256']) {
      expect(provenance[key]).toMatch(/^[0-9a-f]{64}$/u);
    }
    const programs = record(provenance.programSha256);
    expect([fileSha('./beamImpact.py'), fileSha('../runtime/assets/beamImpact.py'), fileSha('./beamAnalysis.py'),
      fileSha('../runtime/assets/beamAnalysis.py'), fileSha('./beamImpactRuntime.ts'),
      fileSha('./beamImpactNativeInterior.harness.mjs'), fileSha('./beamImpactNativeInterior.test.py')])
      .toEqual([programs.impact, programs.impact, programs.analysis, programs.analysis, programs.runtime,
        programs.harness, programs.oracle]);
    // Runtime asset pins the capture ran with; archive or index pins of the manifest may change independently.
    const manifest = record(record(JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'))).files);
    const assets = Object.entries(record(provenance.runtimeAssetPins));
    expect(assets.map(([name]) => name)).toContain('beamImpact.py');
    for (const [name, pin] of assets) expect(manifest[`assets/${name}`]).toEqual(pin);
  });

  it('translates the explicit SI input to exactly the captured plan', () => {
    const { plan } = translateBeamImpact(currentInput());
    // The plan crossed JSON on its way to the native run.
    expect(JSON.parse(JSON.stringify(plan))).toEqual(fixture.plan);
    expect(plan.materials[0].poisson).toBe(YOUNG / (2 * SHEAR) - 1);
    expect(fixture.expectedChecks).toBe(HARNESS_CHECKS);
    expect(fixture.report).toEqual([`beam-impact-native-interior: ${HARNESS_CHECKS} independent checks passed`]);
  });

  it('decodes the captured reply and binds it to its input', async () => {
    const { input, hash, result } = await decoded();
    expect(beamImpactResultMatches(result, input, hash)).toBe(true);
    expect([result.meshNodes, result.meshElements, result.samples.length]).toEqual([SEGMENTS + 1, SEGMENTS, SAMPLE_COUNT]);
    expect(interior(result).elements.map(element => [element.memberId, element.segment, element.lengthM]))
      .toEqual(Array.from({ length: SEGMENTS }, (_, segment) => ['current-member', segment, SEGMENT_LENGTH]));
    expect(ORACLE.length).toBe(SAMPLE_COUNT);
    expect(PEAK).toBeGreaterThan(0);
  });

  it('element end forces equal the closed-form oracle and satisfy the statics of a segment with end loads only', async () => {
    const forces = impactElementEndForces(interior((await decoded()).result));
    expect(forces.map(element => element.segment)).toEqual(Array.from({ length: SEGMENTS }, (_, segment) => segment));
    // Each component may differ from the closed form by 1e-9 PEAK (beamImpactNativeInterior.test.ts); a statics residual
    // combines three components, one scaled by the segment length, plus the closed form's own rounding.
    const staticsTolerance = 1e-9 * PEAK * (3 + 2 * SEGMENT_LENGTH);
    forces.forEach((element, index) => {
      element.start.forEach((start, sample) => {
        const end = element.end[sample];
        const expected = ORACLE[sample][index];
        start.forEach((value, axis) => expect(Math.abs(value - expected.start[axis])).toBeLessThanOrEqual(1e-9 * PEAK));
        end.forEach((value, axis) => expect(Math.abs(value - expected.end[axis])).toBeLessThanOrEqual(1e-9 * PEAK));
        // No distributed load: N, Vy, Vz and T are constant; moments of the end force about the start section.
        [end[0] - start[0], end[1] - start[1], end[2] - start[2], end[3] - start[3],
          end[4] - (start[4] + end[2] * SEGMENT_LENGTH), end[5] - (start[5] - end[1] * SEGMENT_LENGTH)]
          .forEach(residual => expect(Math.abs(residual)).toBeLessThanOrEqual(staticsTolerance));
      });
      // Rest at time zero.
      [...element.start[0], ...element.end[0]].forEach(value => expect(Math.abs(value)).toBe(0));
    });
  });

  it('member-mean resultants equal the length-weighted mean of the linear segment resultants, with sample extremes', async () => {
    const { input, result } = await decoded();
    const member = impactMemberResponse(result, input).members[0];
    // M is linear on a segment with end loads only, so its segment mean is (M_start + M_end) / 2; the member mean is
    // the length-weighted mean of the segment means (closed-form oracle rows).
    const mean = (component: number, sample: number): number => ORACLE[sample].reduce(
      (sum, row) => sum + (row.start[component] + row.end[component]) / 2 * SEGMENT_LENGTH, 0) / LENGTH;
    const tolerance = 1e-9 * PEAK;
    for (const [series, component] of [[member.axialForceN, 0], [member.meanTorqueNm, 3], [member.meanMomentYNm, 4],
      [member.meanMomentZNm, 5]] as const) {
      expect(series.values.length).toBe(SAMPLE_COUNT);
      series.values.forEach((value, sample) => expect(Math.abs(value - mean(component, sample))).toBeLessThanOrEqual(tolerance));
      // Signed extremes among the emitted samples only; the first sample wins a tie.
      const high = Math.max(...series.values);
      const low = Math.min(...series.values);
      const first = series.values.indexOf(high);
      const last = series.values.indexOf(low);
      expect(series.maximum).toEqual({ sample: first, timeS: result.samples[first].timeS, value: high });
      expect(series.minimum).toEqual({ sample: last, timeS: result.samples[last].timeS, value: low });
    }
    // Member-mean axial stress is the centroid value N / A of the combined field (Pa).
    member.axialStressPa.values.forEach((value, sample) =>
      expect(Math.abs(value - mean(0, sample) / AREA)).toBeLessThanOrEqual(tolerance / AREA));
  });

  it('combined normal stress extremes equal sigma = N/A +- |My| h/(2 Iy) +- |Mz| b/(2 Iz) at the outline corners', async () => {
    const section: BeamFibreSection = { kind: 'rectangle', widthYM: WIDTH_Y, depthZM: DEPTH_Z };
    const analysed: AnalysedSection = { areaM2: AREA, iyM4: IY, izM4: IZ };
    // The analysed A, Iy (fibres spread along z) and Iz (fibres along y) are this outline's own values.
    expect(Math.abs(WIDTH_Y * DEPTH_Z - AREA)).toBeLessThanOrEqual(1e-12 * AREA);
    expect(Math.abs(WIDTH_Y * DEPTH_Z ** 3 / 12 - IY)).toBeLessThanOrEqual(1e-12 * IY);
    expect(Math.abs(DEPTH_Z * WIDTH_Y ** 3 / 12 - IZ)).toBeLessThanOrEqual(1e-12 * IZ);
    const checked = checkFibreSection(section, analysed);
    if (checked.status !== 'supported') throw new Error(`the rectangle outline must match the analysed section: ${checked.status}`);
    // Swapped axes and unsupported outlines produce no stress.
    expect(checkFibreSection({ kind: 'rectangle', widthYM: DEPTH_Z, depthZM: WIDTH_Y }, analysed))
      .toMatchObject({ status: 'inconsistent', property: 'iy' });
    expect(checkFibreSection({ kind: 'unsupported', profile: 'user outline' }, analysed))
      .toEqual({ status: 'unsupported', profile: 'user outline' });
    const forces = impactElementEndForces(interior((await decoded()).result));
    const stresses = elementFibreStresses(forces, checked.section, analysed);
    expect(stresses.map(row => [row.element, row.end]))
      .toEqual(forces.flatMap(element => [[element.element, 'start'], [element.element, 'end']]));
    // Each of N, My and Mz may differ from the closed form by 1e-9 PEAK; sigma is linear in them.
    const tolerance = 3e-9 * PEAK * (1 / AREA + DEPTH_Z / 2 / IY + WIDTH_Y / 2 / IZ);
    const sigma = (r: readonly number[], y: number, z: number): number => r[0] / AREA + r[4] * z / IY - r[5] * y / IZ;
    const grid = Array.from({ length: 21 }, (_, i) => (i / 20 - 0.5));
    stresses.forEach(row => {
      const index = forces.findIndex(element => element.element === row.element);
      const rows = ORACLE.map(sampleRows => sampleRows[index][row.end]);
      const tension = rows.map(r => r[0] / AREA + Math.abs(r[4]) * DEPTH_Z / 2 / IY + Math.abs(r[5]) * WIDTH_Y / 2 / IZ);
      const compression = rows.map(r => r[0] / AREA - Math.abs(r[4]) * DEPTH_Z / 2 / IY - Math.abs(r[5]) * WIDTH_Y / 2 / IZ);
      const high = Math.max(...tension);
      const low = Math.min(...compression);
      expect(Math.abs(row.tension.stressPa - high)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(row.compression.stressPa - low)).toBeLessThanOrEqual(tolerance);
      // A scan of the whole section (edges and interior) finds nothing beyond the closed-form extremes.
      const scanned = rows.flatMap(r => grid.flatMap(y => grid.map(z => sigma(r, y * WIDTH_Y, z * DEPTH_Z))));
      expect(Math.abs(Math.max(...scanned) - high)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(Math.min(...scanned) - low)).toBeLessThanOrEqual(tolerance);
      for (const fibre of [row.tension, row.compression]) {
        expect([Math.abs(fibre.yM), Math.abs(fibre.zM)]).toEqual([WIDTH_Y / 2, DEPTH_Z / 2]);
        expect(Math.abs(sigma(rows[fibre.sample], fibre.yM, fibre.zM) - fibre.stressPa)).toBeLessThanOrEqual(tolerance);
      }
      // The governing sample is the closed-form one, unless another sample lies within the tolerance band.
      expect(tension.flatMap((value, sample) => (value >= high - 2 * tolerance ? [sample] : []))).toContain(row.tension.sample);
      expect(compression.flatMap((value, sample) => (value <= low + 2 * tolerance ? [sample] : [])))
        .toContain(row.compression.sample);
    });
    // Axial force and both bending moments act at the support, so the stress there is a genuine combination.
    const support = ORACLE.map(sampleRows => sampleRows[0].start);
    for (const component of [0, 4, 5]) {
      expect(Math.max(...support.map(r => Math.abs(r[component])))).toBeGreaterThan(1e-6 * PEAK);
    }
  });

  it('makes no yield or full-strength claim without a sourced allowable', async () => {
    const forces = impactElementEndForces(interior((await decoded()).result));
    const checked = checkFibreSection({ kind: 'rectangle', widthYM: WIDTH_Y, depthZM: DEPTH_Z }, { areaM2: AREA, iyM4: IY, izM4: IZ });
    if (checked.status !== 'supported') throw new Error('the rectangle outline must match the analysed section');
    const peakPa = Math.max(...elementFibreStresses(forces, checked.section, { areaM2: AREA, iyM4: IY, izM4: IZ })
      .flatMap(row => [Math.abs(row.tension.stressPa), Math.abs(row.compression.stressPa)]));
    expect(Number.isFinite(peakPa) && peakPa > 0).toBe(true);
    expect(compareWithYield(peakPa, null))
      .toEqual({ status: 'data-missing', reason: 'no sourced yield strength applies to this beam material and condition' });
    expect(Object.keys(constants).filter(key => /yield|allowable|strength|capacity|safety/iu.test(key))).toEqual([]);
  });
});
