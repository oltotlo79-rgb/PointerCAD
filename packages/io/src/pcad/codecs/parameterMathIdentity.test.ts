import { describe, expect, it } from 'vitest';
import { readParameter, readParameters, serializeParameter } from './parameters.js';
const legacy = { name: 'sin', value: { source: '3', value: 3, display: '3' }, unit: 'mm' as const, description: '' };
describe('係数IDの保存と旧形式の互換性', () => {
  it('旧形式へIDやundefined欄を追加しない', () => {
    expect(serializeParameter(legacy)).toEqual(legacy);
    expect(readParameter(legacy, 'p')).toEqual({ ok: true, value: legacy });
  });
  it('新しい参照をJSON往復しても名前とは独立して保つ', () => {
    const parameter = { ...legacy, mathId: 'coefficient:3' };
    const raw: unknown = JSON.parse(JSON.stringify(serializeParameter(parameter)));
    expect(readParameter(raw, 'p')).toEqual({ ok: true, value: parameter });
  });
  it.each([null, undefined, 1, '', 'bad\nname', 'a'.repeat(129)])('不正なID %jの位置を報告する', mathId => {
    expect(readParameter({ ...legacy, mathId }, 'document.parameters[0]'))
      .toMatchObject({ ok: false, problem: { path: 'document.parameters[0].mathId', reason: 'type' } });
  });
  it('別の名前で重複したIDの位置を報告する', () => {
    expect(readParameters({ parameters: [{ ...legacy, mathId: 'same' }, { ...legacy, name: 'log', mathId: 'same' }] }, 'document'))
      .toMatchObject({ ok: false, problem: { path: 'document.parameters[1].mathId', reason: 'type' } });
  });
});
