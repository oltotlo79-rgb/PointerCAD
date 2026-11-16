import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 押せる面の下限と、チェックの箱と名前の並び(UI の点検の指摘 18・40)。CSS の規則を読むだけの試験で、画面の実測は画面検査に任せる。
const css = readFileSync(new URL('./appShell.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

/** 選び方の並び(カンマ区切り)に selector そのものを含む規則の、宣言の部分を全て返す。 */
function declarations(selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(match => match[1].split(',').map(part => part.trim()).includes(selector))
    .map(match => match[2]);
}

/** property(min- や max- の付かない名前はそのものだけ)に書いた px の値を全て返す。 */
function pixels(selector: string, property: string): number[] {
  const pattern = new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+)px`, 'gu');
  return declarations(selector).flatMap(body => [...body.matchAll(pattern)].map(match => Number(match[1])));
}

describe('押せる面は 24px 以上(UI の点検の指摘 18)', () => {
  it.each([
    ['.pcad-parameter__action', 'width'], ['.pcad-parameter__action', 'height'],
    ['.pcad-constraint-row__remove', 'width'], ['.pcad-constraint-row__remove', 'height'],
    ['.pcad-commandline__suggestion', 'height'], ['.pcad-parameter__head', 'min-height'],
  ] as const)('%s の %s', (selector, property) => {
    const values = pixels(selector, property);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toBeGreaterThanOrEqual(24);
  });
});

describe('部品表の「組の中身も出す」は、チェックの箱と名前を隣に置く(UI の点検の指摘 40)', () => {
  it('両端へ離す規則は並び順の札だけに付ける', () => {
    expect(declarations('.pcad-bom__expand').length).toBeGreaterThan(0);
    expect(declarations('.pcad-bom__expand').join(';')).not.toMatch(/justify-content:\s*space-between/u);
    expect(declarations('.pcad-bom__sort').join(';')).toMatch(/justify-content:\s*space-between/u);
  });
});
