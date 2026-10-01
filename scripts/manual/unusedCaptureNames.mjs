/**
 * Report-only check (w148a, 2026-09-29): which capture names passed to `captureManualDetail(` in
 * `e2e/tests/*Flow.ts` are never referenced by any chapter image (`images/<name>-detail.png` or
 * `images/<name>-screen.png` in a `packages/help-content/docs/ja/*.md` link). A capture script existing
 * is not the same as a chapter actually showing its image — the same gap that let 30 of 110 chapters
 * ship without any image (see chapterImagePolicy.mjs).
 *
 * Decision (w148a): report only, do not fail the release check. Of the 9 found when this module was
 * written, 5 were already known (KNOWN_UNUSED_CAPTURE_NAMES, each with a recorded reason) and the other
 * 4 are newly found scripted captures whose adoption is undecided; failing the gate on them would block
 * unrelated releases on a photography decision. `checkUnusedCaptureNames` still separates "known" from
 * "new" so a new orphan cannot silently accumulate unnoticed.
 */
import { log } from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Literal `name: '...'` inside one `captureManualDetail(page, info, { ... })` call (dynamic names, e.g. a template literal, are not matched and are reported separately as unresolved). */
const CAPTURE_CALL = /captureManualDetail\(\s*page\s*,\s*info\s*,\s*\{[^}]*?name:\s*'([a-z][a-z0-9-]*)'/gsu;
const CAPTURE_CALLS_COUNT = /captureManualDetail\(/gu;
const IMAGE_LINK = /!\[[^\]]*\]\(([^\s)]+)\)/gu;

/** Known orphans and why adopting them into a chapter is not simply "add the image link". */
export const KNOWN_UNUSED_CAPTURE_NAMES = Object.freeze({
  'command-line-suggestions': 'command-line.md にはコマンド欄の別の状態(相対座標の入力)の画像は使っているが、'
    + '候補一覧の状態の画像はまだ本文に差し込んでいない(w143a の目録で既知)。',
  'import-properties': 'import.md には単位を訊く小窓の画像は使っているが、読み込み後のプロパティの画像はまだ本文に差し込んでいない(w143a の目録で既知)。',
  'math-geometry-reference-2': 'math-geometry-reference.md には一覧の先頭側の画像は使っているが、スクロール末尾側の2枚目はまだ本文に差し込んでいない(w143a の目録で既知)。',
});

const isKnown = name => Object.hasOwn(KNOWN_UNUSED_CAPTURE_NAMES, name);

/**
 * @param {readonly { path: string, text: string }[]} flowSources e2e/tests/*Flow.ts contents.
 * @param {readonly { name: string, text: string }[]} chapters packages/help-content/docs/ja/*.md contents.
 */
export function checkUnusedCaptureNames(flowSources, chapters) {
  const referencedImages = new Set();
  for (const { text } of chapters) {
    for (const match of text.matchAll(IMAGE_LINK)) {
      const target = match[1].replace(/^\.\//u, '');
      if (target.startsWith('images/')) referencedImages.add(target.slice('images/'.length));
    }
  }
  const isReferenced = name => [...referencedImages].some(image => image.startsWith(`${name}-`));

  const names = new Set();
  const unresolvedCalls = [];
  for (const { path, text } of flowSources) {
    const calls = [...text.matchAll(CAPTURE_CALLS_COUNT)].length;
    const literal = new Set([...text.matchAll(CAPTURE_CALL)].map(match => match[1]));
    for (const name of literal) names.add(name);
    if (literal.size < calls) unresolvedCalls.push({ path, calls, literalNames: literal.size });
  }

  const unused = [...names].filter(name => !isReferenced(name)).sort();
  return {
    flowFiles: flowSources.length, captureNames: names.size, unresolvedCalls,
    unused, known: unused.filter(isKnown).map(name => ({ name, reason: KNOWN_UNUSED_CAPTURE_NAMES[name] })),
    newlyFound: unused.filter(name => !isKnown(name)),
    staleKnownEntries: Object.keys(KNOWN_UNUSED_CAPTURE_NAMES).filter(name => !unused.includes(name)),
  };
}

/** `node scripts/manual/unusedCaptureNames.mjs`: prints the report as JSON. Report-only — always exits 0. */
async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const flowDir = join(root, 'e2e/tests'), chapterDir = join(root, 'packages/help-content/docs/ja');
  const flowSources = [];
  for (const entry of await readdir(flowDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('Flow.ts')) flowSources.push({ path: entry.name, text: await readFile(join(flowDir, entry.name), 'utf8') });
  }
  const chapters = [];
  for (const entry of await readdir(chapterDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) chapters.push({ name: entry.name, text: await readFile(join(chapterDir, entry.name), 'utf8') });
  }
  const result = checkUnusedCaptureNames(flowSources, chapters);
  log(JSON.stringify({ command: 'unused-capture-names', reportOnly: true, ...result }, null, 2));
  if (result.staleKnownEntries.length > 0) {
    log('注意: KNOWN_UNUSED_CAPTURE_NAMES の一部が既に使われています。一覧から削除してください（このコマンド自体は失敗させません）。');
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? invokedPath.toLowerCase() === modulePath.toLowerCase() : invokedPath === modulePath) {
  await main();
}
