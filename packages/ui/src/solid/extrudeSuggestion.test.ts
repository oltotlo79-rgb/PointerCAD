import type { Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { choiceValueOf, createNumericInput, reduceNumericInput, type NumericInputState } from '../sketch/numericInput.js';
import { suggestExtrudeOperations, withExtrudeSuggestions, type ExtrudeSuggestions, type SuggestionBody } from './extrudeSuggestion.js';

// M-01 の「提案して見せる」(案 1): 位置と押す向きから、結果(新しい立体・結合・切り抜き)と相手を提案する。

/** 軸に沿った箱の三角形(12 枚、外向き)。`origin` を渡すと、局所の座標(原点からの差)で持つ。 */
function boxBody(featureId: string, min: Vec3, max: Vec3, origin?: Vec3): SuggestionBody {
  const base = origin ?? [0, 0, 0];
  const corner = (x: number, y: number, z: number): number[] => [
    (x === 0 ? min[0] : max[0]) - base[0], (y === 0 ? min[1] : max[1]) - base[1], (z === 0 ? min[2] : max[2]) - base[2]];
  const positions = new Float32Array([
    ...corner(0, 0, 0), ...corner(1, 0, 0), ...corner(1, 1, 0), ...corner(0, 1, 0),
    ...corner(0, 0, 1), ...corner(1, 0, 1), ...corner(1, 1, 1), ...corner(0, 1, 1),
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  const volume = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  return { featureId, mesh: { positions, indices }, volume,
    ...(origin === undefined ? {} : { coordinateFrame: { origin, maximumFloat32ErrorMm: 1e-5 } }) };
}

const BOX = boxBody('extrude-1', [0, 0, 0], [20, 20, 20]);

describe('点が立体の中か(三角形の網で判定する。提案にだけ使う)', () => {
  it('局所の座標で持つ箱も、原点を足して世界座標で見分ける。体積の無い開いた面は中を持たない', () => {
    const local = boxBody('extrude-2', [100, 0, 0], [120, 20, 20], [100, 0, 0]);
    expect(suggestExtrudeOperations([110, 10, 20], [0, 0, 1], [local], ['extrude-2']).forward)
      .toEqual({ operation: 'join', target: 'extrude-2' });
    expect(suggestExtrudeOperations([10, 10, 20], [0, 0, 1], [local], ['extrude-2']).forward).toEqual({ operation: 'new', target: '' });
    const sheet = { ...BOX, volume: 0 };
    expect(suggestExtrudeOperations([5, 5, 20], [0, 0, 1], [sheet], ['extrude-1']).forward).toEqual({ operation: 'new', target: '' });
  });
});

describe('位置と押す向きから、結果と相手を提案する', () => {
  it('上面にかいた領域: 外へ押すと結合、内へ押すと切り抜き、両側は結合', () => {
    const suggestions = suggestExtrudeOperations([5, 5, 20], [0, 0, 1], [BOX], ['extrude-1']);
    expect(suggestions).toEqual({
      forward: { operation: 'join', target: 'extrude-1' },
      reverse: { operation: 'cut', target: 'extrude-1' },
      symmetric: { operation: 'join', target: 'extrude-1' },
    });
  });

  it('向きが逆の領域(法線が -Z)では、反転しない時が切り抜きになる', () => {
    const suggestions = suggestExtrudeOperations([5, 5, 20], [0, 0, -1], [BOX], ['extrude-1']);
    expect(suggestions.forward).toEqual({ operation: 'cut', target: 'extrude-1' });
    expect(suggestions.reverse).toEqual({ operation: 'join', target: 'extrude-1' });
  });

  it('立体から離れた所は、どの向きでも新しい立体', () => {
    const suggestions = suggestExtrudeOperations([100, 100, 20], [0, 0, 1], [BOX], ['extrude-1']);
    const fresh = { operation: 'new', target: '' };
    expect(suggestions).toEqual({ forward: fresh, reverse: fresh, symmetric: fresh });
  });

  it('立体の中の領域を両側へ押すと切り抜き。相手の候補に無い立体(使われた立体)は相手にしない', () => {
    expect(suggestExtrudeOperations([10, 10, 10], [0, 0, 1], [BOX], ['extrude-1']).symmetric)
      .toEqual({ operation: 'cut', target: 'extrude-1' });
    expect(suggestExtrudeOperations([5, 5, 20], [0, 0, 1], [BOX], []).forward).toEqual({ operation: 'new', target: '' });
  });
});

const TARGETS = [{ value: 'extrude-1', label: '箱1' }];
const SUGGESTIONS: ExtrudeSuggestions = {
  forward: { operation: 'join', target: 'extrude-1' },
  reverse: { operation: 'cut', target: 'extrude-1' },
  symmetric: { operation: 'join', target: 'extrude-1' },
};

function extrudeInput(): NumericInputState {
  return createNumericInput('extrude', 'extrudeDistance', undefined, { extrudeTargets: TARGETS });
}
function choice(state: NumericInputState, key: 'extrudeOperation' | 'extrudeTarget') {
  const found = state.choices.find(entry => entry.key === key);
  if (found === undefined) throw new Error(`選択肢 ${key} がありません`);
  return found;
}

describe('提案を欄へ入れる(手で選んだ後は上書きしない)', () => {
  it('提案を結果と相手の欄へ入れ、「提案」の印と理由を付ける', () => {
    const state = withExtrudeSuggestions(extrudeInput(), SUGGESTIONS);
    expect(choiceValueOf(state, 'extrudeOperation')).toBe('join');
    expect(choiceValueOf(state, 'extrudeTarget')).toBe('extrude-1');
    expect(choice(state, 'extrudeOperation').suggestion).toEqual({ reasonKey: 'numericInput.extrudeSuggestion.join', name: '箱1' });
    expect(choice(state, 'extrudeTarget').suggestion).toEqual({});
  });

  it('反転のつまみを切り替えると、押す向きに合わせて提案を入れ直す', () => {
    const reversed = reduceNumericInput(withExtrudeSuggestions(extrudeInput(), SUGGESTIONS), { type: 'toggle', key: 'reversed' });
    expect(choiceValueOf(reversed, 'extrudeOperation')).toBe('cut');
    expect(choice(reversed, 'extrudeOperation').suggestion?.reasonKey).toBe('numericInput.extrudeSuggestion.cut');
  });

  it('新しい立体の提案では、印を付けず、相手を空にする', () => {
    const fresh = { operation: 'new', target: '' } as const;
    const state = withExtrudeSuggestions(extrudeInput(), { forward: fresh, reverse: fresh, symmetric: fresh });
    expect(choiceValueOf(state, 'extrudeOperation')).toBe('new');
    expect(choiceValueOf(state, 'extrudeTarget')).toBe('');
    expect(choice(state, 'extrudeOperation').suggestion).toBeUndefined();
  });

  it('結果か相手を手で選んだら、その後に向きを変えても領域を選び直しても上書きしない(印も消す)', () => {
    const chosen = reduceNumericInput(withExtrudeSuggestions(extrudeInput(), SUGGESTIONS),
      { type: 'choose', key: 'extrudeOperation', value: 'new' });
    expect(chosen.extrudeChoiceManual).toBe(true);
    expect(choice(chosen, 'extrudeOperation').suggestion).toBeUndefined();
    expect(choice(chosen, 'extrudeTarget').suggestion).toBeUndefined();
    const toggled = reduceNumericInput(chosen, { type: 'toggle', key: 'reversed' });
    expect(choiceValueOf(toggled, 'extrudeOperation')).toBe('new');
    const repicked = withExtrudeSuggestions(toggled, SUGGESTIONS);
    expect(choiceValueOf(repicked, 'extrudeOperation')).toBe('new');
    expect(choice(repicked, 'extrudeOperation').suggestion).toBeUndefined();
  });

  it('提案の無い押し出し(面を選んで開いた時)は、つまみを切り替えても結果を変えない', () => {
    const toggled = reduceNumericInput(extrudeInput(), { type: 'toggle', key: 'reversed' });
    expect(choiceValueOf(toggled, 'extrudeOperation')).toBe('new');
    expect(toggled.extrudeChoiceManual).toBeUndefined();
  });
});
