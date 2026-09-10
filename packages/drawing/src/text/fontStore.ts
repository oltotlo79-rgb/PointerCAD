import type { RenderSubpath, SemanticTextMetrics } from '../render/types.js';
import { DRAWING_FONT_ASSET } from './fontAsset.js';
import { textOutline, type GlyphPathCommand } from './textOutline.js';
import { createOutlineCache } from './outlineCache.js';

/** 字体の解析と取得を注入できる境界。文字の配置・輪郭化は同じ字体から求める。 */
export interface DrawingFont {
  readonly id: string;
  hasGlyph(character: string): boolean;
  commands(text: string, sizeMm: number): readonly GlyphPathCommand[];
  advance(text: string, sizeMm: number): number;
}

export type FontLoadStatus = 'unloaded' | 'loading' | 'ready' | 'failed';
export interface OutlinedText {
  readonly status: FontLoadStatus | 'missingGlyph' | 'invalidText';
  readonly subpaths: readonly RenderSubpath[];
  readonly fillRule: 'nonzero';
  /** 未読込・欠字時の枠を実測した文字幅として使わない。 */
  readonly metrics: SemanticTextMetrics | null;
  readonly missingCharacters: readonly string[];
}

export async function parseDrawingFont(bytes: ArrayBuffer): Promise<DrawingFont> {
  const { parse } = await import('opentype.js');
  const font = parse(bytes);
  return {
    id: DRAWING_FONT_ASSET.id,
    hasGlyph: (character) => font.charToGlyphIndex(character) !== 0,
    commands: (text, sizeMm) => font.getPath(text, 0, 0, sizeMm).commands,
    advance: (text, sizeMm) => font.getAdvanceWidth(text, sizeMm),
  };
}

async function fetchFont(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Font HTTP ${response.status}`);
  return response.arrayBuffer();
}

function fallback(status: OutlinedText['status'], sizeMm: number, missingCharacters: readonly string[] = []): OutlinedText {
  // これは欠字/未読込の印であり、文字幅を推測した代替の字形ではない。
  const size = Number.isFinite(sizeMm) && sizeMm > 0 ? sizeMm : 3.5;
  return { status, metrics: null, missingCharacters, fillRule: 'nonzero', subpaths: [{ commands: [
    { kind: 'M', to: [0, 0] }, { kind: 'L', to: [size, 0] },
    { kind: 'L', to: [size, size] }, { kind: 'L', to: [0, size] }, { kind: 'Z' },
  ] }] };
}

/** 非同期資産のキャッシュ。利用者の編集状態や図面文書はここへ保存しない。 */
export function createFontStore(options: {
  readonly url?: string;
  readonly read?: (url: string) => Promise<ArrayBuffer>;
  readonly parse?: (bytes: ArrayBuffer) => DrawingFont | Promise<DrawingFont>;
} = {}) {
  let status: FontLoadStatus = 'unloaded';
  let font: DrawingFont | null = null;
  let pending: Promise<FontLoadStatus> | null = null;
  const outlines = createOutlineCache();
  const load = (): Promise<FontLoadStatus> => {
    if (status === 'ready') return Promise.resolve(status);
    if (pending !== null) return pending;
    status = 'loading';
    pending = Promise.resolve().then(() => (options.read ?? fetchFont)(options.url ?? DRAWING_FONT_ASSET.url))
      .then((bytes) => (options.parse ?? parseDrawingFont)(bytes))
      .then((loaded) => { font = loaded; status = 'ready' as const; return status; })
      .catch(() => { font = null; status = 'failed' as const; return status; })
      .finally(() => { pending = null; });
    return pending;
  };
  const outline = (text: string, sizeMm: number): OutlinedText => {
    if (!Number.isFinite(sizeMm) || sizeMm <= 0) return fallback('invalidText', sizeMm);
    const loadedFont = font;
    if (loadedFont === null) return fallback(status, sizeMm);
    const cached = outlines.get(text, sizeMm);
    if (cached !== undefined) return cached;
    try {
      const missing = [...new Set([...text].filter((character) => !loadedFont.hasGlyph(character)))];
      if (missing.length > 0) return fallback('missingGlyph', sizeMm, missing);
      const geometry = textOutline(loadedFont.commands(text, sizeMm));
      const advanceMm = loadedFont.advance(text, sizeMm);
      if (geometry === null || !Number.isFinite(advanceMm) || advanceMm < 0) return fallback('invalidText', sizeMm);
      const result: OutlinedText = { status: 'ready', subpaths: geometry.subpaths, fillRule: geometry.fillRule, missingCharacters: [],
        metrics: { fontId: loadedFont.id, sizeMm, advanceMm, inkBounds: geometry.inkBounds } };
      outlines.put(text, sizeMm, result);
      return result;
    } catch {
      return fallback('invalidText', sizeMm);
    }
  };
  return { load, outline, get status(): FontLoadStatus { return status; } };
}
