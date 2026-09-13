import { beforeAll, describe, expect, it } from 'vitest';
import {
  createMathBackend,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import { mathPaletteAvailability } from './mathPalette.js';
import { MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES, mathPaletteExampleSource } from './mathPaletteExamples.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
describe('公開パレットの実テンプレートを構造入力と同じ経路で評価する', () => {
  it.each(MATH_PALETTE_EXAMPLES)('$idの記号と引数が期待した数値・型になる', example => {
    const request = { identity: { documentId: 'palette', documentVersion: 1, editorId: example.id, inputRevision: 1 },
      source: mathPaletteExampleSource(example), notation: 'latex' as const, angleUnit: 'degree' as const, coefficients: [] };
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.definition?.source, JSON.stringify(result.evaluation)).toBe(request.source);
    if (typeof example.expected === 'number') {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result.evaluation));
      expect(result.evaluation.coordinate).toBeCloseTo(example.expected, 11);
    } else expect(result.evaluation).toMatchObject({ status: 'value', kind: example.expected });
  });
  it('公開項目には評価対象の実例と登録済みの演算があり、未検査の下書きは含まない', () => {
    const ids = new Set(MATH_PALETTE_EXAMPLES.map(example => `mathPaletteExamples:${example.id}`));
    expect(new Set(MATH_INPUT_PALETTE.map(item => item.id)).size).toBe(MATH_INPUT_PALETTE.length);
    for (const item of MATH_INPUT_PALETTE) expect(mathPaletteAvailability(item, new Set(CANDIDATE_MATH_BY_ID.keys()), ids), item.id).toBe(true);
  });
});
