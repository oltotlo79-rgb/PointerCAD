import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { decodeMathExpressionStorage } from './mathExpressionStorage.js';
import { decodeMathWorkReply, type MathWorkResult } from './mathWorkReply.js';
import type { MathNode } from './mathInputContract.js';

const backend = createMathBackend();
function request(source: string, notation: 'text' | 'latex' = 'text'): MathWorkRequest {
  return { source, notation, angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'short-derivatives', documentVersion: 1, editorId: 'equation', inputRevision: 1 } };
}
function read(source: string, notation: 'text' | 'latex' = 'text'): MathWorkResult & { readonly expression: MathNode | null } {
  const input = request(source, notation);
  const result = decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend), input, {
    operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
  }).result;
  return { ...result, expression: result.definition?.expression ?? null };
}
const plain = [
  ['odesolve([dy/dx=y],x,[y],[[y,0,2]])', 'odesolve([diff(y,x)=y],x,[y],[[y,0,2]])'],
  ['odesolve([y″=-y],x,[y],[[y,0,0],[y′,0,1]])', 'odesolve([diff(y,x,x)=-y],x,[y],[[y,0,0],[diff(y,x),0,1]])'],
  ["odesolve([y''=-y],x,[y],[[y,0,0],[y',0,1]])", 'odesolve([diff(y,x,x)=-y],x,[y],[[y,0,0],[diff(y,x),0,1]])'],
  ['odesolve([y′=z,z′=-y],x,[y,z],[[y,0,0],[z,0,1]])', 'odesolve([diff(y,x)=z,diff(z,x)=-y],x,[y,z],[[y,0,0],[z,0,1]])'],
  ['odesolve([y‴=0],x,[y],[])', 'odesolve([diff(y,x,x,x)=0],x,[y],[])'],
  ['odesolve([y⁗=0],x,[y],[])', 'odesolve([diff(y,x,x,x,x)=0],x,[y],[])'],
  ['odesolve([y′^2=1],x,[y],[])', 'odesolve([diff(y,x)^2=1],x,[y],[])'],
] as const;
const structured = [
  [String.raw`\operatorname{odesolve}([\frac{dy}{dx}=y],x,[y],[[y,0,2]])`, plain[0][1]],
  [String.raw`\operatorname{odesolve}([\frac{\mathrm{d}y}{\mathrm{d}x}=y],x,[y],[[y,0,2]])`, plain[0][1]],
  [String.raw`\operatorname{odesolve}([y^{\prime\prime}=-y],x,[y],[[y,0,0],[y^{\prime},0,1]])`, plain[1][1]],
  [String.raw`\operatorname{odesolve}([y''=-y],x,[y],[[y,0,0],[y',0,1]])`, plain[1][1]],
  [String.raw`\operatorname{odesolve}([y″=-y],x,[y],[[y,0,0],[y^\prime,0,1]])`, plain[1][1]],
  [String.raw`\operatorname{pde}([\frac{\partial u}{\partial t}=\operatorname{diff}(u,x,x)],[x,t],[u],[[u,[0,t],0]])`,
    'pde([diff(u,t)=diff(u,x,x)],[x,t],[u],[[u,[0,t],0]])'],
] as const;

describe('短い微分表記は指定された関数と変数の意味を保つ', () => {
  it.each([...plain.map(([source, canonical]) => ({ source, canonical, notation: 'text' as const })),
    ...structured.map(([source, canonical]) => ({ source, canonical, notation: 'latex' as const }))])(
    '$sourceを通常の微分と照合し、保存と表示切替で同じ意味を保持する', ({ source, canonical, notation }) => {
      const result = read(source, notation), expected = read(canonical);
      if (result.expression === null || expected.expression === null || result.definition == null) {
        throw new Error(JSON.stringify({ source, result: result.evaluation, expected: expected.evaluation }));
      }
      expect(sameMathMeaning(result.expression, expected.expression)).toBe(true);
      expect(result.definition.source).toBe(source);
      const restored = decodeMathExpressionStorage(JSON.parse(JSON.stringify(result.definition)), source);
      expect(restored).toEqual(result.definition);
      const rendered = executeMathWorkRequest(createMathWorkEnvelope(2, {
        ...request(source, notation), definition: restored, presentationNotation: notation === 'text' ? 'latex' : 'text',
      }), backend);
      if (rendered.presentation == null) throw new Error(JSON.stringify(rendered.evaluation));
      const back = read(rendered.presentation.source, rendered.presentation.inputNotation);
      if (back.expression === null) throw new Error(JSON.stringify(back.evaluation));
      expect(sameMathMeaning(result.expression, back.expression)).toBe(true);
    });

  it.each([
    "y'", 'dy/dx', 'odesolve([z′=y],x,[y],[])', 'odesolve([y′′′′′′′′′=0],x,[y],[])',
    'odesolve([dy/dt=y],x,[y],[])', 'pde([u′=u],[x,t],[u],[])',
  ])('意味が決まらない表記 %s を数値や解として採用しない', source => {
    expect(read(source).evaluation.status).toBe('invalid');
  });
  it.each([
    String.raw`\operatorname{pde}([\frac{du}{dt}=u],[x,t],[u],[])`,
    String.raw`\operatorname{odesolve}([\frac{dy}{dt}=y],x,[y],[])`,
    String.raw`\operatorname{odesolve}([y^{\prime+1}=0],x,[y],[])`,
  ])('変数が不明または曖昧な構造入力 %s を拒否する', source => {
    expect(read(source, 'latex').evaluation.status).toBe('invalid');
  });
  it('dyとdx自体が宣言された名前なら勝手に分割しない', () => {
    const source = 'odesolve([diff(dy,dx)=dy/dx],dx,[dy],[])';
    const result = read(source);
    expect(result.expression).not.toBeNull();
    expect(result.definition?.source).toBe(source);
    const wronglySplit = read('odesolve([diff(dy,dx)=diff(dy,dx)],dx,[dy],[])');
    if (result.expression === null || wronglySplit.expression === null) throw new Error('式がありません。');
    expect(sameMathMeaning(result.expression, wronglySplit.expression)).toBe(false);
  });
});
