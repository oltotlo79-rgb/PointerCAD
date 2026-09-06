/**
 * 柄のテクスチャ(計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク8、FR-1108)。
 *
 * `packages/ui/vitest.config.ts` は `environment: 'node'` で jsdom を入れない
 * (`themeColors.ts` 冒頭の注釈と同じ方針)。このファイルの検査は次の2段に分かれる。
 *
 * - `patternDrawCommands` / `patternAlphaDrawCommands` / `patternCacheKey` /
 *   `patternRepeatFor` / `drawPattern`: three にも DOM にも触れない純関数なので、
 *   ここで実際の値を確かめる(乱数を使わないことの検査を含む)。
 * - `createPatternTexture` / `disposePatternTextures`: 実描画は
 *   `document.createElement('canvas')` がある環境だけで行う設計であり、この Node の
 *   検査環境には `document` が無い。したがってここで確かめられるのは
 *   「canvas の無い環境では必ず `null` を返し、例外を投げない」ことまでで、
 *   使い回し(同じ引数で同じ参照)・`dispose()` 後の作り直し・512×512の実寸・
 *   `alphaTexture` の非 null は、実際に canvas が取れる環境(ブラウザ/Electron、
 *   タスク9・10・56)で確かめる。この限界は報告に明記する。
 */

import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import {
  createPatternTexture,
  disposePatternTextures,
  drawPattern,
  PATTERN_TEXTURE_SIZE,
  patternAlphaDrawCommands,
  patternCacheKey,
  patternDrawCommands,
  type PatternDrawCommand,
  patternRepeatFor,
  type PatternRenderingContext2D,
} from './patternTexture.js';

/** 呼ばれた命令をそのまま記録するだけの、偽の描画道具。 */
function createFakeContext(): PatternRenderingContext2D & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    beginPath(): void {
      calls.push('beginPath()');
    },
    moveTo(x, y): void {
      calls.push(`moveTo(${x},${y})`);
    },
    lineTo(x, y): void {
      calls.push(`lineTo(${x},${y})`);
    },
    stroke(): void {
      calls.push('stroke()');
    },
    fill(): void {
      calls.push('fill()');
    },
    fillRect(x, y, width, height): void {
      calls.push(`fillRect(${x},${y},${width},${height})`);
    },
    ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle): void {
      calls.push(`ellipse(${x},${y},${radiusX},${radiusY},${rotation},${startAngle},${endAngle})`);
    },
  };
}

const WOOD_A = { size: 64, baseColor: '#cbab7d', grainColor: '#9c7a4a' };
const WOOD_B = { size: 64, baseColor: '#6b4a33', grainColor: '#442d1e' };

describe('PATTERN_TEXTURE_SIZE', () => {
  it('512である(§2.4.3)', () => {
    expect(PATTERN_TEXTURE_SIZE).toBe(512);
  });
});

describe('patternDrawCommands', () => {
  it("'none' は空の列", () => {
    expect(patternDrawCommands('none', { size: 64 })).toEqual([]);
  });

  it('エキスパンドメタルは1つ以上の命令を出す', () => {
    const commands = patternDrawCommands('expandedMetal', { size: 64 });
    expect(commands.length).toBeGreaterThan(0);
  });

  it('縞鋼板は1つ以上の命令を出す', () => {
    const commands = patternDrawCommands('checkerPlate', { size: 64 });
    expect(commands.length).toBeGreaterThan(0);
  });

  it('木目は1つ以上の命令を出す', () => {
    const commands = patternDrawCommands('woodGrain', WOOD_A);
    expect(commands.length).toBeGreaterThan(0);
  });

  it('同じ引数(エキスパンドメタル)で2回描くと同じ命令の並びになる(乱数を使っていない)', () => {
    const first = patternDrawCommands('expandedMetal', { size: 64 });
    const second = patternDrawCommands('expandedMetal', { size: 64 });
    expect(second).toEqual(first);
  });

  it('同じ引数(木目)で2回描くと同じ命令の並びになる(乱数を使っていない)', () => {
    const first = patternDrawCommands('woodGrain', WOOD_A);
    const second = patternDrawCommands('woodGrain', WOOD_A);
    expect(second).toEqual(first);
  });

  it('別の樹種の色を渡すと fillStyle の値が変わる', () => {
    const a = patternDrawCommands('woodGrain', WOOD_A);
    const b = patternDrawCommands('woodGrain', WOOD_B);
    expect(a.length).toBe(b.length);
    const differs = a.some((command, index) => {
      const other = b[index];
      return command.op === 'fillStyle' && other.op === 'fillStyle' && command.value !== other.value;
    });
    expect(differs).toBe(true);
  });

  it('エキスパンドメタルの対角線は size の外(-size〜2size)まで余分に引く(継ぎ目合わせ)', () => {
    const size = 64;
    const commands = patternDrawCommands('expandedMetal', { size });
    const moveToXs = commands.filter((command): command is Extract<PatternDrawCommand, { op: 'moveTo' }> => command.op === 'moveTo').map((command) => command.x);
    expect(moveToXs).toContain(-size);
    expect(moveToXs).toContain(size * 2);
  });
});

describe('patternAlphaDrawCommands', () => {
  it('エキスパンドメタルだけ非 null で、1つ以上の命令を出す', () => {
    const commands = patternAlphaDrawCommands('expandedMetal', { size: 64 });
    expect(commands).not.toBeNull();
    expect((commands ?? []).length).toBeGreaterThan(0);
  });

  it('縞鋼板は null', () => {
    expect(patternAlphaDrawCommands('checkerPlate', { size: 64 })).toBeNull();
  });

  it('木目は null', () => {
    expect(patternAlphaDrawCommands('woodGrain', WOOD_A)).toBeNull();
  });

  it("'none' は null", () => {
    expect(patternAlphaDrawCommands('none', { size: 64 })).toBeNull();
  });

  it('色のテクスチャと桟の位置(対角線の始点)が同じ', () => {
    const size = 64;
    const color = patternDrawCommands('expandedMetal', { size });
    const alpha = patternAlphaDrawCommands('expandedMetal', { size });
    const colorMoveTo = color.filter((command) => command.op === 'moveTo');
    const alphaMoveTo = (alpha ?? []).filter((command) => command.op === 'moveTo');
    expect(alphaMoveTo).toEqual(colorMoveTo);
  });
});

describe('drawPattern', () => {
  it('偽の道具へ、命令の列どおりに呼び出しを行う', () => {
    const context = createFakeContext();
    const commands: readonly PatternDrawCommand[] = [
      { op: 'fillStyle', value: '#112233' },
      { op: 'fillRect', x: 1, y: 2, width: 3, height: 4 },
      { op: 'strokeStyle', value: '#445566' },
      { op: 'lineWidth', value: 5 },
      { op: 'beginPath' },
      { op: 'moveTo', x: 0, y: 0 },
      { op: 'lineTo', x: 10, y: 10 },
      { op: 'stroke' },
      { op: 'ellipse', x: 1, y: 2, radiusX: 3, radiusY: 4, rotation: 0, startAngle: 0, endAngle: 6 },
      { op: 'fill' },
    ];
    drawPattern(context, commands);
    expect(context.fillStyle).toBe('#112233');
    expect(context.strokeStyle).toBe('#445566');
    expect(context.lineWidth).toBe(5);
    expect(context.calls).toEqual([
      'fillRect(1,2,3,4)',
      'beginPath()',
      'moveTo(0,0)',
      'lineTo(10,10)',
      'stroke()',
      'ellipse(1,2,3,4,0,0,6)',
      'fill()',
    ]);
  });

  it('エキスパンドメタルの命令を渡すと、対角線の本数ぶん stroke() が呼ばれる', () => {
    const context = createFakeContext();
    const size = 64;
    const commands = patternDrawCommands('expandedMetal', { size });
    drawPattern(context, commands);
    const strokeCount = context.calls.filter((call) => call === 'stroke()').length;
    const expectedStrokeCount = commands.filter((command) => command.op === 'stroke').length;
    expect(strokeCount).toBe(expectedStrokeCount);
    expect(strokeCount).toBeGreaterThan(0);
  });

  it('縞鋼板の命令を渡すと、突起(楕円)の数ぶん fill() が呼ばれる(4本 × 2枚重ね = 8)', () => {
    const context = createFakeContext();
    const commands = patternDrawCommands('checkerPlate', { size: 64 });
    drawPattern(context, commands);
    const ellipseCount = context.calls.filter((call) => call.startsWith('ellipse(')).length;
    const fillCount = context.calls.filter((call) => call === 'fill()').length;
    expect(ellipseCount).toBe(8);
    expect(fillCount).toBe(8);
  });
});

describe('patternRepeatFor', () => {
  it('縞鋼板の既定の間隔(20mm)は 1/20 になる(1枚が表す実寸は spacing そのもの = 20mm。画素数(512px)には依らない)', () => {
    expect(patternRepeatFor(20)).toBeCloseTo(0.05, 10);
  });

  it('エキスパンドメタルの既定の間隔(12mm)は 1/12 になる', () => {
    expect(patternRepeatFor(12)).toBeCloseTo(1 / 12, 10);
  });

  it('木目の既定の間隔(6mm、年輪の間隔)は 1/6 になる', () => {
    expect(patternRepeatFor(6)).toBeCloseTo(1 / 6, 10);
  });
});

describe('patternCacheKey', () => {
  it('同じ引数なら同じ鍵', () => {
    const a = patternCacheKey('woodGrain', { baseColor: '#111111', grainColor: '#222222' });
    const b = patternCacheKey('woodGrain', { baseColor: '#111111', grainColor: '#222222' });
    expect(a).toBe(b);
  });

  it('樹種の色が違えば別の鍵', () => {
    const a = patternCacheKey('woodGrain', { baseColor: '#111111', grainColor: '#222222' });
    const b = patternCacheKey('woodGrain', { baseColor: '#333333', grainColor: '#222222' });
    expect(a).not.toBe(b);
  });

  it('柄の種類が違えば別の鍵', () => {
    const a = patternCacheKey('expandedMetal', {});
    const b = patternCacheKey('checkerPlate', {});
    expect(a).not.toBe(b);
  });
});

describe('createPatternTexture(canvas の無い Node の環境)', () => {
  it("'none' は null", () => {
    expect(createPatternTexture('none', {})).toBeNull();
  });

  it('エキスパンドメタルは null(document が無いため)', () => {
    expect(typeof document).toBe('undefined');
    expect(createPatternTexture('expandedMetal', {})).toBeNull();
  });

  it('縞鋼板は null(document が無いため)', () => {
    expect(createPatternTexture('checkerPlate', {})).toBeNull();
  });

  it('木目は null(document が無いため)', () => {
    expect(createPatternTexture('woodGrain', { baseColor: '#cbab7d', grainColor: '#9c7a4a' })).toBeNull();
  });
});

describe('disposePatternTextures', () => {
  it('キャッシュが空でも例外を投げない(冪等)', () => {
    expect(() => {
      disposePatternTextures();
    }).not.toThrow();
    expect(() => {
      disposePatternTextures();
    }).not.toThrow();
  });
});

describe('1枚の生成にかかる時間(実測、目標10ms未満。§1.5-10 の注記のとおり報告する)', () => {
  it('命令の作成 + 適用(偽の道具)の所要を計る(実際の Canvas 2D のラスタライズは Node に無いため測れない)', () => {
    const context = createFakeContext();
    const kinds = ['expandedMetal', 'checkerPlate', 'woodGrain'] as const;
    const measurements: Record<string, number> = {};
    for (const kind of kinds) {
      const options = kind === 'woodGrain' ? { size: PATTERN_TEXTURE_SIZE, baseColor: '#cbab7d', grainColor: '#9c7a4a' } : { size: PATTERN_TEXTURE_SIZE };
      const startedAt = performance.now();
      const commands = patternDrawCommands(kind, options);
      drawPattern(context, commands);
      measurements[kind] = performance.now() - startedAt;
    }
    console.info('[実測][patternTexture] 命令の作成+適用(512px、偽の道具)の所要(ms):', measurements);
    for (const kind of kinds) {
      expectWithinBudget(measurements[kind], 200, `柄「${kind}」の命令の作成+適用`);
    }
  });
});
