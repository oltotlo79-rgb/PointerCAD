import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createSixDofGate } from './sixDofGate.js';

/* 3D マウス(設計 B-09 3-5)の印。読めない・壊れた・未来の版は切、入は残せた時だけ。 */
const PATH = join('dir', 'input-devices.json');
type SixDofGateFiles = NonNullable<Parameters<typeof createSixDofGate>[1]>;

function memoryFiles(initial: string | null, failWrite = false): SixDofGateFiles & { readonly saved: Map<string, string> } {
  const saved = new Map<string, string>();
  if (initial !== null) saved.set(PATH, initial);
  return {
    saved,
    read: (path) => { const text = saved.get(path); if (text === undefined) throw new Error('ENOENT'); return text; },
    write: (path, text) => { if (failWrite) throw new Error('EACCES'); saved.set(path, text); },
    rename: (from, to) => { const text = saved.get(from); if (text === undefined) throw new Error('ENOENT'); saved.delete(from); saved.set(to, text); },
  };
}

/** 保存の中身 text(null はファイル無し)から始めた印が入か。 */
const readSixDofEnabled = (text: string | null): boolean => createSixDofGate('dir', memoryFiles(text)).enabled();

describe('印の読み取り', () => {
  it('版 1 で sixDofEnabled が真偽の true の時だけ入、ほかは全部切', () => {
    expect(readSixDofEnabled('{"version":1,"sixDofEnabled":true}')).toBe(true);
    for (const text of [null, '', '{', '[]', 'null', 'true', '{"version":2,"sixDofEnabled":true}', '{"version":"1","sixDofEnabled":true}',
      '{"version":1,"sixDofEnabled":"true"}', '{"version":1,"sixDofEnabled":1}', '{"version":1}', '{"sixDofEnabled":true}']) {
      expect(readSixDofEnabled(text), String(text)).toBe(false);
    }
  });
});

describe('印の保存', () => {
  it('ファイルが無い・壊れている時は切で始まる', () => {
    expect(createSixDofGate('dir', memoryFiles(null)).enabled()).toBe(false);
    expect(createSixDofGate('dir', memoryFiles('{broken')).enabled()).toBe(false);
    expect(createSixDofGate('dir', memoryFiles('{"version":1,"sixDofEnabled":true}')).enabled()).toBe(true);
  });

  it('入は隣に書いてから置き換えて残せた時だけ入になり、残せなければ切のまま', () => {
    const files = memoryFiles(null);
    const gate = createSixDofGate('dir', files);
    expect(gate.set(true)).toBe(true);
    expect(gate.enabled()).toBe(true);
    expect(readSixDofEnabled(files.saved.get(PATH) ?? null)).toBe(true);
    expect([...files.saved.keys()]).toEqual([PATH]);
    const failing = createSixDofGate('dir', memoryFiles(null, true));
    expect(failing.set(true)).toBe(false);
    expect(failing.enabled()).toBe(false);
  });

  it('切は残せなくても切にする(読めない方へ倒す)', () => {
    const write = vi.fn(() => { throw new Error('EACCES'); });
    const files = { ...memoryFiles('{"version":1,"sixDofEnabled":true}'), write };
    const gate = createSixDofGate('dir', files);
    expect(gate.enabled()).toBe(true);
    expect(gate.set(false)).toBe(true);
    expect(gate.enabled()).toBe(false);
  });
});
