import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { createSolidAnalysisSession, solidSavedInput } from './solidAnalysisSession.js';
import { createSolidBoundaryDraft, createSolidSupport, solidBoundarySaved,
  solidGravityExpressionField, solidSupportExpressionField } from './solidBoundaryDraft.js';

const supports = [
  { face: 'left', fixed: [true, false, false], prescribedMm: [0.125, 0, 0] },
  { face: 'front', fixed: [false, true, false], prescribedMm: [0, -0.25, 0] },
  { face: 'bottom', fixed: [false, false, true], prescribedMm: [0, 0, 0.5] },
];
const gravity = { accelerationMps2: [1.25, -9.81, 2.5], densityKgM3: 7800 };
function saved(mode: 'traction' | 'pressure', boundary: 'none' | 'supports' | 'gravity' | 'both') {
  const common = { id: 'solid-cad', source: { documentId: 'part' }, bodyFeatureId: 'box',
    fixedFaces: boundary === 'supports' || boundary === 'both' ? [] : ['bottom'],
    loadedFaces: boundary === 'gravity' || boundary === 'both' ? [] : ['top'], youngMPa: 210000, poisson: 0.3,
    ...(boundary === 'supports' || boundary === 'both' ? { supports } : {}),
    ...(boundary === 'gravity' || boundary === 'both' ? { gravity } : {}),
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
  return readSolidCadSavedInput(mode === 'traction' ? { schema: 'pointercad-solid-cad-input/1', ...common, tractionMPa: [0, 0, -2] }
    : { schema: 'pointercad-solid-cad-input/2', ...common, load: 'pressure', pressureMPa: 2 });
}
describe('solid boundary drafts keep the saved physical definition', () => {
  it.each(['traction', 'pressure'] as const)('restores and resaves all three boundary cases for %s exactly', mode => {
    for (const boundary of ['supports', 'gravity', 'both'] as const) {
      const input = saved(mode, boundary), session = createSolidAnalysisSession('owner', input);
      expect(solidSavedInput(session, 'part', []), boundary).toEqual(input);
      expect(JSON.stringify(solidSavedInput(session, 'part', [])), boundary).toBe(JSON.stringify(input));
      expect(session.result).toBeNull();
    }
  });
  it.each(['traction', 'pressure'] as const)('preserves absent fields and legacy bytes for %s', mode => {
    const input = saved(mode, 'none'), session = createSolidAnalysisSession('owner', input);
    const reopened = solidSavedInput(session, 'part', []);
    expect(JSON.stringify(reopened)).toBe(JSON.stringify(input));
    expect(Object.hasOwn(reopened, 'supports')).toBe(false);
    expect(Object.hasOwn(reopened, 'gravity')).toBe(false);
  });
  it('copies saved arrays and preserves omitted prescribed values', () => {
    const input = saved('traction', 'supports');
    const definition = readSolidCadSavedInput({ ...input, supports: [{ face: 'left', fixed: [true, true, true] }] });
    const draft = createSolidBoundaryDraft(definition);
    if (!definition.supports) throw new Error('Missing support fixture');
    Reflect.set(definition.supports[0].fixed, 0, false);
    expect(draft.supports[0].fixed).toEqual([true, true, true]);
    expect(solidBoundarySaved(draft, [])).toEqual({ supports: [{ face: 'left', fixed: [true, true, true] }] });
  });
  it('keeps disabled gravity drafts out of the saved input and never guesses density', () => {
    const draft = createSolidBoundaryDraft();
    expect(draft.gravity.density).toBe('');
    expect(solidBoundarySaved({ gravity: { enabled: false, density: 'bad', acceleration: ['bad', '', 'Infinity'] } }, [])).toEqual({});
    expect(() => solidBoundarySaved({ gravity: { ...draft.gravity, enabled: true } }, [])).toThrow();
  });
  it('rejects all-free supports and nonzero free-axis displacement', () => {
    const row = createSolidSupport('left');
    expect(() => solidBoundarySaved({ supports: [{ ...row, fixed: [false, false, false] }] }, [])).toThrow();
    expect(() => solidBoundarySaved({ supports: [{ ...row, fixed: [true, false, false], displacement: ['1', '2', '0'] }] }, [])).toThrow();
  });
});
describe('boundary units and expressions', () => {
  it('evaluates signed millimetres, acceleration and explicit density while retaining the typed source', () => {
    // Existing length contract: evaluate.test.ts (FR-814), 1 in = 25.4 mm; cm is unsupported.
    expect(solidSupportExpressionField('x', 'support-x', '-20mm', []).result.value?.value).toBe(-20);
    expect(solidSupportExpressionField('x', 'support-x', '-0.5in', []).result.value?.value).toBe(-12.7);
    expect(solidSupportExpressionField('x', 'support-x', '-2cm', []).result.value).toBeNull();
    for (const suffix of ['m/s²', 'm/s2', 'm/s^2']) {
      const source = `(-9.81 / 2) ${suffix}`, field = solidGravityExpressionField('z', source, []);
      expect(field.result.value?.value).toBe(-4.905);
      expect(field.field.source).toBe(source); expect(field.unitLabel).toBe('m/s²');
      expect(field.result.key).toBe(field.field.key);
    }
    expect(solidGravityExpressionField('density', '7800 kg/m³', []).result.value?.value).toBe(7800);
  });
  it.each(['', 'Infinity', '1e309', '2mm', '2 mm/s²', '2cm/s²', '2 MPa'])('rejects invalid acceleration %s', source => {
    expect(solidGravityExpressionField('x', source, []).result.value).toBeNull();
  });
  it.each(['0', '-1', '', '1 mm', 'Infinity'])('rejects density %s', source => {
    expect(solidGravityExpressionField('density', source, []).result.value).toBeNull();
  });
});


function javascriptNameCollisions(names: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const output = name.replace(/\.(?:ts|tsx)$/u, '').toLowerCase();
    counts.set(output, (counts.get(output) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name).sort();
}
it('keeps boundary JS output names unambiguous on case-insensitive filesystems', () => {
  expect(javascriptNameCollisions(['solidBoundaryFields.ts', 'SolidBoundaryFields.tsx'])).toEqual(['solidboundaryfields']);
  const actual = readdirSync(new URL('.', import.meta.url)).filter(name => /^solidBoundary.*\.(?:ts|tsx)$/iu.test(name));
  expect(actual).toContain('solidBoundaryDraft.ts');
  expect(actual).toContain('SolidBoundaryFields.tsx');
  expect(javascriptNameCollisions(actual)).toEqual([]);
});
