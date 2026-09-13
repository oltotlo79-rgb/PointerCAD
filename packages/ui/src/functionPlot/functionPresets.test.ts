import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFunctionMathSource,
  createMathBackend,
} from '@pointercad/expression/math/worker';

import {
  createFunctionCurveEvaluator,
  createFunctionSurfaceEvaluator,
} from '@pointercad/expression/math/geometry';

import { FUNCTION_PRESETS, applyFunctionPreset } from './functionPresets.js';
import { functionPlotDraft, FUNCTION_AXES } from './functionPlotDraft.js';

let backend: ReturnType<typeof createMathBackend>;
beforeAll(()=>{backend=createMathBackend();});

describe('式の例は全XYZの指定を代用しない', () => {
  it.each(['circle','helix','sphere','torus'] as const)('%sは度の1/4周で元の大きさ・向き・らせんの高さを保つ',id=>{
    const preset=FUNCTION_PRESETS.find(value=>value.id===id);if(!preset) throw new Error('Missing preset');
    const draft=applyFunctionPreset(functionPlotDraft(undefined,preset.geometry),preset),surface=preset.geometry==='surface';
    const definitions=FUNCTION_AXES.map(axis=>createFunctionMathSource(draft.outputs[axis].source,'text',draft.outputs[axis].angleUnit,
      {axes:[],parameters:surface?['U','V']:['T'],coefficients:[]},backend));
    const outputs=[definitions[0],definitions[1],definitions[2]] as const,context={backend,shouldStop:()=>undefined};
    const point=surface?createFunctionSurfaceEvaluator(outputs,['U','V'],[],context).point([90,90])
      :createFunctionCurveEvaluator(outputs,'T',[],context).point(90);
    const expected=id==='torus'?[0,2,1]:[0,1,id==='helix'?0.25:0];
    expect(point).not.toBeNull();for(let axis=0;axis<3;axis++) expect(point?.[axis]).toBeCloseTo(expected[axis],12);
  });
  it.each(FUNCTION_PRESETS)('$idを選んでも6境界は空のままで、精度も勝手に変えない', preset => {
    const draft=functionPlotDraft(undefined,preset.geometry), result=applyFunctionPreset(draft,preset);
    for (const axis of FUNCTION_AXES) for (const side of ['min','max'] as const) {
      expect(result.scalars[`${axis}.${side}`]).toBe(draft.scalars[`${axis}.${side}`]);
      expect(result.scalars[`${axis}.${side}`].source).toBe('');
    }
    expect(result.scalars.tolerance).toBe(draft.scalars.tolerance);
    expect(result.outputs.Z.angleUnit).toBe('degree'); expect(result.form).toBe(preset.form);
  });
  it('入力済みの範囲を保持し、別の形の例で既存の履歴を変えない', () => {
    const initial=functionPlotDraft(undefined,'surface'), draft={...initial,scalars:{...initial.scalars,'Z.max':{source:'coef("上限")',angleUnit:'degree' as const}}};
    const sphere=FUNCTION_PRESETS.find(value=>value.id==='sphere'), circle=FUNCTION_PRESETS.find(value=>value.id==='circle');
    if (!sphere || !circle) throw new Error('Missing presets');
    const result=applyFunctionPreset(draft,sphere);
    expect(result.scalars['Z.max']).toBe(draft.scalars['Z.max']);
    expect(result.scalars['U.max'].source).toBe('360'); expect(result.scalars['V.max'].source).toBe('180');
    expect(applyFunctionPreset(draft,circle)).toBe(draft);
  });
});
