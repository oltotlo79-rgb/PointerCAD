import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFontStore } from './fontStore.js';
import { DRAWING_FONT_ASSET } from './fontAsset.js';
import { cubicBezierPoint } from '../render/bezierArc.js';
import type { RenderSubpath } from '../render/types.js';
import type { Point2 } from '../types.js';

const repositoryRoot = new URL('../../../../', import.meta.url);
// 検査ファイルの移動や../の誤りを「字体未導入」として黙ってskipしない。
if (!existsSync(new URL('pnpm-workspace.yaml', repositoryRoot))) throw new Error('字体検査のリポジトリ起点が違います');
const webFont = new URL('apps/web/public/fonts/NotoSansJP-Regular.otf', repositoryRoot);
const desktopFont = new URL('apps/desktop/resources/fonts/NotoSansJP-Regular.otf', repositoryRoot);
const available = existsSync(webFont);
if (!available) console.warn('[字体検査SKIP] NotoSansJP-Regular.otfがありません。純関数の検査は継続します。');

function signedArea({ commands }: RenderSubpath): number {
  const points: Point2[] = [];
  let from: Point2 = [0, 0];
  for (const command of commands) {
    if (command.kind === 'Z') continue;
    if (command.kind === 'C') {
      for (let i = 1; i <= 64; i += 1) points.push(cubicBezierPoint({ from, ...command }, i / 64));
    } else points.push(command.to);
    from = command.to;
  }
  return points.reduce((sum, [x, y], i) => {
    const next = points[(i + 1) % points.length]; return sum + x * next[1] - y * next[0];
  }, 0) / 2;
}

describe.skipIf(!available)('同梱した実字体による文字の輪郭(P8-44)', () => {
  const store = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(webFont)).buffer) });
  beforeAll(async () => { expect(await store.load()).toBe('ready'); });

  it('Webとdesktopで同じ版・hash・バイト数の字体を配る', () => {
    for (const path of [webFont, desktopFont]) {
      const bytes = readFileSync(path);
      expect(bytes.length).toBe(DRAWING_FONT_ASSET.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(DRAWING_FONT_ASSET.sha256);
    }
  });
  it.each(['8', 'φ', '日', '板'])('%sの輪郭が空でなく、全て閉じている', (text) => {
    const outline = store.outline(text, 3.5);
    expect(outline.status).toBe('ready');
    expect(outline.subpaths).toHaveLength(3);
    expect(outline.subpaths.every(({ commands }) => commands[0].kind === 'M' && commands.at(-1)?.kind === 'Z')).toBe(true);
    expect(outline.fillRule).toBe('nonzero');
    expect(outline.metrics?.advanceMm).toBeGreaterThan(0);
  });
  it.each(['8', '日'])('%sの外周と2つの穴の向きが逆になる', (text) => {
    const areas = store.outline(text, 3.5).subpaths.map(signedArea).sort((a, b) => Math.abs(b) - Math.abs(a));
    expect(areas).toHaveLength(3);
    expect(areas[0] * areas[1]).toBeLessThan(0);
    expect(areas[0] * areas[2]).toBeLessThan(0);
    expect(Math.abs(areas[0])).toBeGreaterThan(Math.abs(areas[1]) + Math.abs(areas[2]));
  });
  it('3.5mmの数字の墨の高さは実測0.757倍、送り幅は1.9425mm', () => {
    const metrics = store.outline('8', 3.5).metrics;
    if (metrics === null) throw new Error('字体が読めない');
    expect((metrics.inkBounds.top - metrics.inkBounds.bottom) / 3.5).toBeCloseTo(0.757, 12);
    expect(metrics.advanceMm).toBeCloseTo(1.9425, 12);
  });
  it('高さを2倍にすると輪郭と送り幅が2倍になる', () => {
    const small = store.outline('板', 3.5), large = store.outline('板', 7);
    expect(large.metrics?.advanceMm).toBe((small.metrics?.advanceMm ?? 0) * 2);
    expect(large.metrics?.inkBounds.right).toBe((small.metrics?.inkBounds.right ?? 0) * 2);
  });
  it('空白は輪郭がなくても送り幅がある', () => {
    const result = store.outline(' ', 3.5);
    expect(result.status).toBe('ready');
    expect(result.subpaths).toEqual([]);
    expect(result.metrics?.advanceMm).toBeGreaterThan(0);
  });
  it('未収録文字はnotdefを本当の文字として出さない', () => {
    expect(store.outline('\u{10FFFF}', 3.5)).toMatchObject({ status: 'missingGlyph', metrics: null, missingCharacters: ['\u{10FFFF}'] });
  });
  it('同じ日本語の文から完全に同じ輪郭ができる', () => {
    expect(store.outline('板厚3.5 φ8', 3.5)).toEqual(store.outline('板厚3.5 φ8', 3.5));
  });
});
