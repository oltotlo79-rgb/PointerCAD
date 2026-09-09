import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFontStore } from '../text/fontStore.js';
import { toPdf } from './toPdf.js';
import { toSvg } from './toSvg.js';
import type { RenderDocument, RenderPath, RenderText } from './types.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
if (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) throw new Error('PDF検査のリポジトリ起点が違います');
const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(resolve(root, 'apps/web/public/fonts/NotoSansJP-Regular.otf'))).buffer) });
const transform = [1, 0, 0, 1, 0, 0] as const;
function text(value: string, x: number, y: number, size = 8): RenderText {
  const outlined = font.outline(value, size);
  if (outlined.status !== 'ready' || outlined.metrics === null) throw new Error('実字体を輪郭化できません');
  return { kind: 'text', ownerId: value, layerId: 'text', transform, clip: null, fill: '#000000',
    text: value, position: [x, y], angle: 0, anchor: 'start', baseline: 'alphabetic',
    outline: outlined.subpaths, metrics: outlined.metrics };
}
function line(x: number, y: number, width: number, dash: readonly number[] = []): RenderPath {
  return { kind: 'path', ownerId: 'line', layerId: 'lines', transform, clip: null, fill: null, fillRule: 'nonzero',
    stroke: { color: '#000000', widthMm: 0.5, dashMm: dash },
    subpaths: [{ commands: [{ kind: 'M', to: [x, y] }, { kind: 'L', to: [x + width, y] }] }] };
}
function pdf(document: RenderDocument): Uint8Array {
  const result = toPdf(document, { title: 'PointerCAD 図面出力の確認' });
  if (!result.ok) throw new Error(result.reason);
  return result.bytes;
}
function artifact(name: string, content: Uint8Array | string): void {
  const requested = process.env.POINTERCAD_PDF_QA_DIR;
  if (requested === undefined) return;
  const allowed = resolve(root, 'scratchpad'), directory = resolve(requested), fromAllowed = relative(allowed, directory);
  if (isAbsolute(fromAllowed) || fromAllowed.startsWith('..')) throw new Error('PDF確認用の出力はscratchpad内だけに置きます');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, name), content);
}

describe('実字体のPDF出力と500文字の実測（P8-46）', () => {
  beforeAll(async () => { expect(await font.load()).toBe('ready'); });

  it('8・日・φ・公差・破線・白抜きをA3の同じIRからPDFとSVGへ出す', () => {
    const mask: RenderPath = { ...line(0, 0, 1), stroke: null, fill: '#ffffff', subpaths: [{ commands: [
      { kind: 'M', to: [40, 170] }, { kind: 'L', to: [95, 170] }, { kind: 'L', to: [95, 195] },
      { kind: 'L', to: [40, 195] }, { kind: 'Z' },
    ] }] };
    const document: RenderDocument = { widthMm: 420, heightMm: 297, primitives: [
      text('8 日 φ', 20, 240, 24), text('20±0.1', 20, 215, 10),
      text('破線', 175, 205), line(20, 205, 140, [3, 1]),
      line(20, 182, 140), mask, text('白抜き', 45, 180, 8),
      text('A3 横 420×297 mm', 20, 130),
      line(20, 100, 100), text('100 mm', 50, 105, 5),
    ] };
    const bytes = pdf(document), svg = toSvg(document);
    expect(svg).not.toBeNull();
    expect(new TextDecoder().decode(bytes)).not.toMatch(/\/(Font|Image)\b/u);
    expect(pdf(document)).toEqual(bytes);
    artifact('pdf-acceptance.pdf', bytes);
    if (svg !== null) artifact('pdf-acceptance.svg', svg);
  });

  it('A3・線5000本に文字500個を加えた容量と作成時間を記録する', () => {
    const lines = Array.from({ length: 5000 }, (_, index) => line(10 + index % 100, 10 + Math.floor(index / 100), 100));
    const baseline = pdf({ widthMm: 420, heightMm: 297, primitives: lines });
    const started = performance.now();
    const alphabet = [...'8日φ板0123456789'];
    const texts = Array.from({ length: 500 }, (_, index) => text(alphabet[index % alphabet.length], 20 + index % 50 * 7, 100 + Math.floor(index / 50) * 10, 3.5));
    const bytes = pdf({ widthMm: 420, heightMm: 297, primitives: [...lines, ...texts] });
    const elapsedMs = performance.now() - started;
    const measured = { lineCount: 5000, characterCount: 500, linesOnlyBytes: baseline.byteLength,
      withTextBytes: bytes.byteLength, textIncreaseBytes: bytes.byteLength - baseline.byteLength, elapsedMs };
    console.log(`[実測] A3 PDF: ${JSON.stringify(measured)}`);
    expect(baseline.byteLength).toBeGreaterThanOrEqual(175000);
    expect(baseline.byteLength).toBeLessThanOrEqual(525000);
    expect(bytes.byteLength).toBeGreaterThan(baseline.byteLength);
    expect(elapsedMs).toBeLessThan(2000);
    artifact('pdf-5000-lines-500-characters.pdf', bytes);
    artifact('pdf-measurement.json', JSON.stringify(measured, null, 2));
  });
});
