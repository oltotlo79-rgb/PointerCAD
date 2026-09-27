import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { createMathLatexCodec } from './mathLatexCodec.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';

// MC-02e: mathLatexFunctions.ts の latexFunction() は通常入力 (mathTextSyntax.ts) と違い、
// forall/exists の第1・第2引数を Element で束縛せず平らな3引数 ['ForAll', 変数, 集合, 条件] を
// 組み立てていた。decodeMathJson.ts はこの形を「量化する変数と集合を指定してください。」で拒否する
// (MC-02d 最終報告 §4-2 が報告した製品の不具合)。この検査は先に失敗させ、latexFunction() の修正後に
// 通常入力と同じ真偽を返すことを確かめる。
const script = fileURLToPath(new URL('./exactRuntime/cas_logic_extended_test.py', import.meta.url));
const codec = createMathLatexCodec();
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
function request(source: string, changes: Partial<MathWorkRequest> = {}): MathWorkRequest {
  return { identity: { documentId: 'quantifier-latex', documentVersion: 1, editorId: 'X', inputRevision: 1 },
    source, notation: 'latex', angleUnit: 'radian', coefficients: [], ...changes };
}
const TRUE_BOOLEAN = { status: 'value', kind: 'boolean', expression: { kind: 'constant', name: 'true' } } as const;
const FALSE_BOOLEAN = { status: 'value', kind: 'boolean', expression: { kind: 'constant', name: 'false' } } as const;

describe('構造入力(LaTeX)の∀・∃は通常入力と同じく変数と集合をElementで束縛する', () => {
  it('presentation変換が再直列化するx\\in{1,2,3}形の再解析も通常入力と同じ形にする', () => {
    // serializeMathLatex.ts は forall/exists 専用の表示を持たず、Element(x, 集合) を
    // 汎用の中置演算子 \in として組み立てる。表示往復はこの文字列を再解析するため、
    // すでに Element で束縛された第1引数もそのまま受け付けることを構文レベルで確かめる。
    expect(codec.parse(String.raw`\operatorname{forall}\left(\left(x\right)\in \left(\left\{1,2,3\right\}\right),\left(x\right)>\left(0\right)\right)`))
      .toEqual(['ForAll', ['Element', 'x', ['Set', 1, 2, 3]], ['Greater', 'x', 0]]);
  });

  it.each([
    [String.raw`\operatorname{forall}\left(x,\left\{1,2,3\right\},x>0\right)`,
      ['ForAll', ['Element', 'x', ['Set', 1, 2, 3]], ['Greater', 'x', 0]]],
    [String.raw`\operatorname{exists}\left(x,\left\{1,2,3\right\},x=2\right)`,
      ['Exists', ['Element', 'x', ['Set', 1, 2, 3]], ['Equal', 'x', 2]]],
  ] as const)('%sの第1・第2引数を通常入力と同じ形に組み立てる', (source, expected) => {
    expect(codec.parse(source)).toEqual(expected);
  });

  it.each([
    String.raw`\operatorname{forall}\left(x,x>0\right)`,
    String.raw`\operatorname{forall}\left(\left\{1,2,3\right\},x,x>0\right)`,
    String.raw`\operatorname{exists}\left(x,\left\{1,2,3\right\}\right)`,
  ])('%sは変数・集合・条件が揃っていないと拒否する', source => {
    expect(() => codec.parse(source)).toThrow('量化する変数、集合、条件を指定してください。');
  });

  it('通常入力と同じ真偽を構造入力でも実計算で返す(修正前は量化する変数と集合を指定してくださいで拒否される)', async () => {
    const backend = createMathBackend();
    const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
    const sources = [
      [String.raw`\operatorname{forall}\left(x,\left\{1,2,3\right\},x>0\right)`, true],
      [String.raw`\operatorname{forall}\left(x,\left\{-1,2,3\right\},x>0\right)`, false],
      [String.raw`\operatorname{exists}\left(x,\left\{1,2,3\right\},x^2=4\right)`, true],
      [String.raw`\operatorname{exists}\left(x,\left\{0,1,3\right\},x^2=4\right)`, false],
      [String.raw`\operatorname{forall}\left(x,\emptyset,x>0\right)`, true],
      [String.raw`\operatorname{exists}\left(x,\emptyset,x>0\right)`, false],
    ] as const;
    const inputs = sources.map(([source]) => request(source));
    const replies = await Promise.all(inputs.map(input =>
      executeExactMathWorkRequest(createMathWorkEnvelope(1, input), { backend, engine, shouldStop: () => undefined })));
    replies.forEach((reply, index) => {
      const [source, expected] = sources[index];
      const result = decodeMathWorkReply(reply, inputs[index], context).result;
      expect(result.evaluation, source).toEqual(expected ? TRUE_BOOLEAN : FALSE_BOOLEAN);
      expect(result.definition, source).toMatchObject({ format: 'pointercad-math/1', source, inputNotation: 'latex' });
    });
  }, 60_000);

  it('LaTeX入力で保存した∀・∃を再読込しても同じ真偽を再計算する', async () => {
    const backend = createMathBackend();
    const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
    const sources = [String.raw`\operatorname{forall}\left(x,\left\{1,2,3\right\},x>0\right)`,
      String.raw`\operatorname{exists}\left(x,\left\{1,2,3\right\},x^2=4\right)`];
    const inputs = sources.map(source => request(source));
    const originals = await Promise.all(inputs.map(input =>
      executeExactMathWorkRequest(createMathWorkEnvelope(2, input), { backend, engine, shouldStop: () => undefined })));
    const reopened = await Promise.all(originals.map((reply, index) => {
      const definition = decodeMathWorkReply(reply, inputs[index], context).result.definition;
      if (definition === null) throw new Error(`元の式を保存できません: ${sources[index]}`);
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...inputs[index], definition })));
      return executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined });
    }));
    reopened.forEach((reply, index) => {
      expect(reply.evaluation).toEqual(originals[index].evaluation);
      expect(reply.evaluation).toEqual(TRUE_BOOLEAN);
      expect(reply.source).toBe(sources[index]);
    });
  }, 60_000);

  it('LaTeX入力の∀をテキスト表示へ変換しても同じ真偽を再計算する', async () => {
    const backend = createMathBackend();
    const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
    const original = request(String.raw`\operatorname{forall}\left(x,\left\{1,2,3\right\},x>0\right)`, { presentationNotation: 'text' });
    const firstReply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, original),
      { backend, engine, shouldStop: () => undefined });
    const first = decodeMathWorkReply(firstReply, original, context).result;
    expect(first.evaluation).toEqual(TRUE_BOOLEAN);
    if (first.presentation === undefined || first.presentation === null) throw new Error('Expected converted notation');
    expect(first.presentation.inputNotation).toBe('text');
    const next: MathWorkRequest = { ...original, source: first.presentation.source, notation: 'text',
      definition: first.presentation, presentationNotation: 'latex' };
    const secondReply = await executeExactMathWorkRequest(createMathWorkEnvelope(5, next),
      { backend, engine, shouldStop: () => undefined });
    const second = decodeMathWorkReply(secondReply, next, context).result;
    expect(second.evaluation).toEqual(first.evaluation);
    expect(second.presentation?.inputNotation).toBe('latex');
  }, 60_000);
});
