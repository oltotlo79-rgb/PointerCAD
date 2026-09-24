/**
 * 「数学記号と演算の一覧」章（packages/help-content/docs/ja/math-symbols.md）を、数学パレットの
 * 目録（packages/ui/src/math/mathPaletteExamples.ts の公開目録）から再生成する。
 * 生成の中身は packages/ui/src/help/mathCatalogHelp.ts の buildMathSymbolsChapterMarkdown が持ち、
 * ここでは scripts/manual/generate.mjs と同じ方式（vite の ssrLoadModule）でTSを直接読み、書き出すだけ。
 * 使い方: node scripts/manual/generateMathSymbolsChapter.mjs
 */
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { log } from 'node:console';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (argv.length > 2) throw new Error('Usage: node scripts/manual/generateMathSymbolsChapter.mjs (no arguments)');
const server = await createServer({ configFile: false, root, logLevel: 'warn',
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, hmr: false } });
try {
  const { MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES } = await server.ssrLoadModule('/packages/ui/src/math/mathPaletteExamples.ts');
  const { buildMathSymbolsChapterMarkdown } = await server.ssrLoadModule('/packages/ui/src/help/mathCatalogHelp.ts');
  const markdown = buildMathSymbolsChapterMarkdown(MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES);
  const targetPath = 'packages/help-content/docs/ja/math-symbols.md';
  await writeFile(resolve(root, targetPath), markdown, 'utf8');
  log(JSON.stringify({ target: targetPath, bytes: Buffer.byteLength(markdown, 'utf8'), items: MATH_INPUT_PALETTE.length }));
} finally {
  await server.close();
}
