/**
 * 機能ごとに分けた文言の表(P6 タスク52)が、分ける前と同じ 1 つの表になることの検査。
 *
 * `ja.ts` は 10 個の JSON を `...` で重ねて 1 つにする。**重ねる順に後ろのものが勝つ**ので、
 * 2 つの JSON が同じ鍵を持つと片方が黙って消える(画面には別の文が出るのに、
 * 型検査もこれまでの検査も何も言わない)。それを落とすのがここ。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ja, JA_PARTS } from './ja.js';
import { MESSAGE_KEYS } from './t.js';

/** 1 つの JSON の中で 2 回目に出た鍵(JSON.parse は後の値を黙って使うので、読んだ表からは見えない)。文言の JSON は 1 段の平らな表。 */
function repeatedKeys(text: string): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const match of text.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gmu)) {
    const key = match[1] ?? '';
    if (seen.has(key)) repeated.push(key);
    seen.add(key);
  }
  return repeated;
}

describe('機能ごとに分けた文言の表(P6 タスク52)', () => {
  it('文字コード変換で日本語が疑問符の列や置換文字に化けていない', () => {
    // PowerShell 5.1の既定パイプへ日本語を流すとASCIIの?へ不可逆変換される。
    // 文言はUTF-8のファイルから書き、壊れた文字列を通常のunit/CIで止める。
    const damaged = Object.entries(ja).filter(([, value]) => /\?{2,}|\uFFFD/u.test(value));
    expect(damaged).toEqual([]);
  });
  it('分けた JSON のあいだで鍵が重なっていない', () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const [part, table] of JA_PARTS) {
      for (const key of Object.keys(table)) {
        const previous = owner.get(key);
        if (previous !== undefined) {
          collisions.push(`${key}(${previous} と ${part})`);
          continue;
        }
        owner.set(key, part);
      }
    }
    expect(collisions, '同じ鍵を 2 つの JSON が持つと、後の JSON が黙って勝つ').toEqual([]);
  });

  it('どの JSON の中にも同じ鍵が 2 回ない(2 回あると後の値が黙って勝つ)', () => {
    const folder = new URL('./ja/', import.meta.url);
    const names = readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
    expect(names.length).toBeGreaterThan(0);
    const repeated = names.flatMap((name) => repeatedKeys(readFileSync(new URL(name, folder), 'utf8')).map((key) => `${name}: ${key}`));
    expect(repeated).toEqual([]);
    expect(repeatedKeys('{\n  "a": "1",\n  "b": "2",\n  "a": "3"\n}\n')).toEqual(['a']);
  });

  it('合わせた表の鍵の数が、分けた表の鍵の数の合計と一致する', () => {
    const total = JA_PARTS.reduce((sum, [, table]) => sum + Object.keys(table).length, 0);
    expect(MESSAGE_KEYS.length).toBe(total);
    expect(Object.keys(ja).length).toBe(total);
  });

  it('分けた表はどれも 1 件以上を持つ(空のファイルを置き忘れない)', () => {
    for (const [part, table] of JA_PARTS) {
      expect(Object.keys(table).length, part).toBeGreaterThan(0);
    }
  });
});
