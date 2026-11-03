import { describe, expect, it } from 'vitest';
import type { CadShellAnalysisResult } from '@pointercad/fem';
import { readShellCadAnalysisInput, type ShellCadAnalysisInput } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import { createShellAnalysisSession, shellFailureMessage, shellNumberText, shellOriginKey, shellSavedInput,
  summarizeShellResult, type ShellAnalysisSession } from './shellAnalysisSession.js';
import { literalShellResult } from './shellAnalysis.testSupport.js';

// Independent literal inputs (the same literal shapes as the io persistence test); nothing is read from a product answer.
const face = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"top"},"shapeKind":"face","version":1}}';
const literal = {
  schema: 'pointercad-shell-cad-analysis/1', id: 'shell-cad-analysis', source: { documentId: 'part' },
  geometry: { schema: 'pointercad-shell-cad-input/1', id: 'shell-cad', source: { documentId: 'part' }, bodyFeatureId: 'sheet',
    midsurfaceFaces: [face], thicknessMm: 2, offsetMm: 0 },
  material: { id: 'material', youngMPa: 210000, poisson: 0.3, source: { kind: 'published', reference: 'handbook table 1', condition: '20 C' } },
  supports: [{ kind: 'edge', origin: { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-front' } },
    fixed: [true, false, true, false, true, false] },
  { kind: 'vertex', origin: { version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId: 'sheet', role: 'top-front-left' } },
    fixed: [true, true, true, false, false, false] }],
  edgeLoads: [{ origin: { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-back' } },
    forceNPerMm: [0, 0, -1.5], momentNmmPerMm: [0, 4, 0] }],
  surface: { linearDeflection: 0.1, angularDeflection: 0.3, maximumNodes: 20000, maximumTriangles: 40000,
    minimumTriangleAreaMm2: 0, minimumAngleDeg: 20, maximumAspectRatio: 4 },
};
const saved: ShellCadAnalysisInput = readShellCadAnalysisInput(literal);

function complete(): ShellAnalysisSession { return createShellAnalysisSession('owner', saved); }

describe('shell analysis draft', () => {
  it('starts with no material, source, support, load or thickness: nothing physical is defaulted', () => {
    const session = createShellAnalysisSession('owner');
    expect(session.values.young).toBe(''); expect(session.values.poisson).toBe(''); expect(session.values.thickness).toBe('');
    expect(session.materialSource).toEqual({ kind: null, reference: '', condition: '' });
    expect(session.supports).toEqual([]); expect(session.edgeLoads).toEqual([]); expect(session.midsurfaceFaces).toEqual([]);
    expect(session.result).toBeNull(); expect(session.status).toBe('editing');
    expect(session.kept).toEqual({ materialId: 'material', maximumNodes: 20000, maximumTriangles: 40000 });
    expect(() => shellSavedInput(session, 'part', [])).toThrow(t('shellAnalysis.needMidsurface'));
  });

  it('reopens a saved definition and writes the same definition back', () => {
    expect(shellSavedInput(complete(), 'part', [])).toEqual(saved);
  });

  it('refuses each missing explicit choice with its own Japanese reason', () => {
    const base = complete();
    expect(() => shellSavedInput({ ...base, supports: [] }, 'part', [])).toThrow(t('shellAnalysis.needSupport'));
    expect(() => shellSavedInput({ ...base, supports: [{ ...base.supports[0], fixed: [false, false, false, false, false, false] }] },
      'part', [])).toThrow(t('shellAnalysis.needFixedDof'));
    expect(() => shellSavedInput({ ...base, materialSource: { ...base.materialSource, kind: null } }, 'part', []))
      .toThrow(t('shellAnalysis.needMaterialSource'));
    expect(() => shellSavedInput({ ...base, materialSource: { ...base.materialSource, reference: '  ' } }, 'part', []))
      .toThrow(t('shellAnalysis.needMaterialSource'));
    expect(() => shellSavedInput({ ...base, values: { ...base.values, poisson: '0.5' } }, 'part', []))
      .toThrow(t('shellAnalysis.poissonRange'));
    for (const bad of ['', 'abc', '1/0']) {
      expect(() => shellSavedInput({ ...base, values: { ...base.values, thickness: bad } }, 'part', [])).toThrow();
      expect(() => shellSavedInput({ ...base, edgeLoads: [{ ...base.edgeLoads[0], values: { ...base.edgeLoads[0].values, fz: bad } }] },
        'part', [])).toThrow();
    }
    expect(() => shellSavedInput({ ...base, values: { ...base.values, thickness: '0' } }, 'part', [])).toThrow();
  });

  it('reads units through the existing expression parser: 210 GPa is 210000 MPa, 2 mm is 2', () => {
    const base = complete();
    const definition = shellSavedInput({ ...base, values: { ...base.values, young: '210 GPa', thickness: '2 mm' } }, 'part', []);
    expect(definition.material.youngMPa).toBe(210000);
    expect(definition.geometry.thicknessMm).toBe(2);
  });

  it('never shows NaN, Infinity or a missing number as a value', () => {
    for (const value of [Number.NaN, Infinity, -Infinity, null, undefined]) {
      expect(shellNumberText(value)).toBe(t('shellAnalysis.notFinite'));
      expect(shellNumberText(value)).not.toBe('0');
    }
    expect(shellNumberText(0)).toBe('0'); expect(shellNumberText(-1.5)).toBe('-1.5');
  });

  it('names every fem refusal in Japanese and keeps an unknown code visible', () => {
    expect(shellFailureMessage('midsurface-solid-face', 'x')).toContain(t('shellAnalysis.failure.solidFace'));
    expect(shellFailureMessage('edge-load-drilling', 'x')).toContain(t('shellAnalysis.failure.drilling'));
    expect(shellFailureMessage('worker-crashed', 'detail')).toContain('worker-crashed');
  });

  it('keys a captured row by its semantic origin only (key order does not matter, the role does)', () => {
    const origin = saved.supports[0].origin;
    const reordered: unknown = JSON.parse('{"identity":{"role":"top-front","featureId":"sheet","kind":"box-edge"},"version":1,"shapeKind":"edge"}');
    const parsed: unknown = JSON.parse(shellOriginKey(origin));
    expect(shellOriginKey(origin)).toBe('{"identity":{"featureId":"sheet","kind":"box-edge","role":"top-front"},"shapeKind":"edge","version":1}');
    expect(parsed).toEqual(reordered);
    expect(shellOriginKey(origin)).not.toBe(shellOriginKey(saved.edgeLoads[0].origin));
  });
});

// rev34 regression: the screen has no field for material.id or the mesh caps, so they must survive load -> edit -> save.
// Every expected value below is a hand-written literal (deliberately not the defaults 'material' / 20000 / 40000).
const keptMaterial = { id: 'saved-material-17', youngMPa: 210000, poisson: 0.3,
  source: { kind: 'measured', reference: 'mill certificate 17', condition: '23 C' } };
const keptSurface = { linearDeflection: 0.05, angularDeflection: 0.25, maximumNodes: 1234, maximumTriangles: 2345,
  minimumTriangleAreaMm2: 0.01, minimumAngleDeg: 15, maximumAspectRatio: 6 };
const keptLiteral = { ...literal, material: keptMaterial, surface: keptSurface };
const otherFace = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"bottom"},"shapeKind":"face","version":1}}';

describe('shell analysis keeps saved values that have no screen field', () => {
  const reopened = (): ShellAnalysisSession => createShellAnalysisSession('owner', readShellCadAnalysisInput(keptLiteral));
  const expectKept = (definition: ShellCadAnalysisInput): void => {
    expect(definition.material.id).toBe('saved-material-17');
    expect(definition.surface.maximumNodes).toBe(1234);
    expect(definition.surface.maximumTriangles).toBe(2345);
  };

  it('writes material.id, maximumNodes and maximumTriangles back exactly as saved, with every other value unchanged', () => {
    const session = reopened();
    expect(session.kept).toEqual({ materialId: 'saved-material-17', maximumNodes: 1234, maximumTriangles: 2345 });
    const definition = shellSavedInput(session, 'part', []);
    expectKept(definition);
    expect(definition.material).toEqual({ id: 'saved-material-17', youngMPa: 210000, poisson: 0.3,
      source: { kind: 'measured', reference: 'mill certificate 17', condition: '23 C' } });
    expect(definition.surface).toEqual({ linearDeflection: 0.05, angularDeflection: 0.25, maximumNodes: 1234,
      maximumTriangles: 2345, minimumTriangleAreaMm2: 0.01, minimumAngleDeg: 15, maximumAspectRatio: 6 });
    expect(definition).toEqual(keptLiteral);
  });

  it('keeps the three values when only the thickness is edited', () => {
    const session = reopened();
    const definition = shellSavedInput({ ...session, values: { ...session.values, thickness: '3.5' } }, 'part', []);
    expectKept(definition);
    expect(definition.geometry.thicknessMm).toBe(3.5);
    expect(definition).toEqual({ ...keptLiteral, geometry: { ...keptLiteral.geometry, thicknessMm: 3.5 } });
  });

  it('keeps the three values when only the midsurface (geometry) is edited', () => {
    const session = reopened();
    const definition = shellSavedInput({ ...session, midsurfaceFaces: [otherFace] }, 'part', []);
    expectKept(definition);
    expect(definition).toEqual({ ...keptLiteral, geometry: { ...keptLiteral.geometry, midsurfaceFaces: [otherFace] } });
  });

  it('keeps the material id when only E is edited (no material is guessed or renamed)', () => {
    const session = reopened();
    const definition = shellSavedInput({ ...session, values: { ...session.values, young: '200000' } }, 'part', []);
    expectKept(definition);
    expect(definition.material).toEqual({ ...keptMaterial, youngMPa: 200000 });
  });

  it('a new draft still saves the existing defaults: material id "material" and the 20000 / 40000 caps', () => {
    const filled = reopened();
    const fresh: ShellAnalysisSession = { ...filled, kept: createShellAnalysisSession('owner').kept };
    const definition = shellSavedInput(fresh, 'part', []);
    expect(definition.material.id).toBe('material');
    expect(definition.surface.maximumNodes).toBe(20000);
    expect(definition.surface.maximumTriangles).toBe(40000);
  });

  it('still refuses invalid kept values through the saved-definition reader', () => {
    const session = reopened();
    for (const kept of [{ ...session.kept, maximumNodes: 2 }, { ...session.kept, maximumTriangles: 0 },
      { ...session.kept, maximumNodes: 12.5 }, { ...session.kept, materialId: '' }]) {
      expect(() => shellSavedInput({ ...session, kept }, 'part', [])).toThrow(t('shellAnalysis.invalidInput'));
    }
  });
});

describe('shell result summary (display only)', () => {
  // Literal fixture: values written in shellAnalysis.testSupport.ts, not produced by the solver.
  const result = (top: number): CadShellAnalysisResult => literalShellResult(saved.geometry, face, top);
  it('summarises the chosen component and the reaction sum; changing the component reads the same result', () => {
    const value = result(7.5);
    const xx = summarizeShellResult(value, 'xx'), yy = summarizeShellResult(value, 'yy');
    expect(xx).toMatchObject({ finite: true, maximumDisplacementMm: 5, maximumRotationRad: 0.5, topMaximumMPa: 7.5, bottomMinimumMPa: -7.5,
      reactionForceN: [0, 2, 3] });
    expect(yy).toMatchObject({ topMaximumMPa: 5, bottomMinimumMPa: -5 });
  });
  it('marks a non-finite stress as not finite instead of a number', () => {
    expect(summarizeShellResult(result(Number.NaN), 'xx').finite).toBe(false);
    expect(summarizeShellResult(result(Infinity), 'xx').finite).toBe(false);
  });
});
