import { findHelpTopic } from '@pointercad/help-content';
import { mathEditorLabels } from '../math/mathEditorLabels.js';
import type { MathPaletteCatalogItem, MathPaletteExample, MathPaletteGroup } from '../math/mathPaletteGroups.js';
import { helpHeadingId } from './HelpMarkdown.js';

/**
 * 「数学記号と演算の一覧」章（math-symbols）を、数学パレットの目録から組み立てる。
 * 手で行を書かず、公開目録（MATH_INPUT_PALETTE）と実例（MATH_PALETTE_EXAMPLES）だけを入力に取る純関数。
 * 実際の章ファイルへの書き出しは scripts/manual/generateMathSymbolsChapter.mjs が担う（このファイルを
 * vite の ssrLoadModule で読み、ここでの結果をそのまま保存する）。目録が増えても、同じコマンドの
 * 再実行だけで章が追いつく（呼出し元が渡す items・examples を差し替えるだけで再計算できるため）。
 */

/** 分野の表示順（FR-210 の記載順に合わせる）。MathPaletteGroup の10種全てを1回ずつ含む。 */
const GROUP_ORDER: readonly MathPaletteGroup[] = [
  'symbols', 'basic', 'functions', 'calculus', 'linear-algebra', 'complex', 'series', 'statistics', 'sets-logic', 'equations',
];

/**
 * ヘルプの用語検査（packages/help-content/src/topics.test.ts の FORBIDDEN_TERMS）は、math-input・
 * math-symbols の両章に限って「連立一次式」（完全な一語として使う場合）を認めている（MC-04b、2026-09-24）。
 * この章の自己検査（本ファイル末尾の findForbiddenHelpTerm）も同じ例外を使い、目録の元の名前と
 * 見出しをそのまま載せる（言い換え・章全体へのリンクへの置き換えはしない）。
 */
const FORBIDDEN_HELP_TERMS: readonly string[] = [
  'B-rep', 'BRep', '指紋', 'テッセレーション', 'Worker', 'ワーカー', 'XCAF', 'ZIP', 'XML', 'グループコード',
  'ソルバー', 'OCCT', 'OpenCascade', 'JSON', 'IndexedDB', 'キャッシュ', 'ヤコビアン', '連立', '四元数', '境界箱', '連結成分',
];
/** topics.test.ts の internalHelpTerms と同じ例外: 完全な「連立一次式」を除いてから禁止語を照合する。 */
function findForbiddenHelpTerm(text: string): string | undefined {
  const withoutException = text.replaceAll('連立一次式', '');
  return FORBIDDEN_HELP_TERMS.find(term => withoutException.includes(term));
}

function assertPlainCell(value: string, context: string): string {
  if (value.includes('|') || value.includes('`') || /[\r\n]/u.test(value)) throw new Error(`Unsupported math symbols chapter text: ${context}`);
  return value;
}
function assertCodeCell(value: string, context: string): string {
  if (value.includes('`') || /[\r\n]/u.test(value)) throw new Error(`Unsupported math symbols chapter code text: ${context}`);
  return value;
}

/** #0・#? の出現順に #1, #2, … を振る（実際の値を入れない「入力の書き方」の欄に使う）。#0 は1個に丸める。 */
function numberedTemplate(template: string): string {
  let slot = 1;
  const hasSelection = template.includes('#0');
  const withSelection = hasSelection ? template.replaceAll('#0', `#${slot++}`) : template;
  return withSelection.replace(/#\?/gu, () => `#${slot++}`);
}

/** #0・#? の出現順に実例の値を入れる（mathPaletteExamples.ts の mathPaletteExampleSource と同じ規則）。 */
function substituteTemplate(template: string, example: Pick<MathPaletteExample, 'selection' | 'slots'>): string {
  let slot = 0;
  const source = template.replaceAll('#0', example.selection).replace(/#\?/gu, () => {
    const value = example.slots[slot++];
    if (value === undefined) throw new Error('Missing math palette argument for chapter example');
    return value;
  });
  if (slot !== example.slots.length) throw new Error('Unused math palette argument for chapter example');
  return source;
}

/** 説明の節（math-input.md の見出し）への個別リンク。元の見出し名をそのまま使う（MC-04b）。 */
function sectionReference(help: string): string {
  const safe = assertPlainCell(help, 'help section title');
  return `[${safe}](math-input.md#${helpHeadingId(help)})`;
}

/** 表の1行。テストは同じ関数で期待値を作り、章の本文にそのまま含まれることを確かめる。 */
export function mathSymbolsChapterRow(item: MathPaletteCatalogItem, example: MathPaletteExample): string {
  if (item.id !== example.id) throw new Error(`Mismatched math palette example: ${item.id}/${example.id}`);
  const name = assertPlainCell(item.label, item.id);
  const symbol = assertCodeCell(item.symbol, item.id);
  const input = assertCodeCell(numberedTemplate(item.template), item.id);
  const worked = assertCodeCell(substituteTemplate(item.template, example), item.id);
  const section = sectionReference(item.help);
  return `| ${name} | \`${symbol}\`／\`${input}\` | \`${worked}\` | ${section} |`;
}

/** 章全体（見出し・分野ごとの表）を目録から組み立てる。手で編集する行を持たない。 */
export function buildMathSymbolsChapterMarkdown(
  items: readonly MathPaletteCatalogItem[], examples: readonly MathPaletteExample[],
): string {
  if (new Set(items.map(entry => entry.id)).size !== items.length) throw new Error('Duplicate math palette catalog id');
  const examplesById = new Map(examples.map(example => [example.id, example]));
  const mathInputTopic = findHelpTopic('math-input');
  if (mathInputTopic === undefined) throw new Error('math-input help topic is missing');
  const byGroup = new Map<MathPaletteGroup, MathPaletteCatalogItem[]>();
  for (const item of items) {
    const list = byGroup.get(item.group);
    if (list === undefined) byGroup.set(item.group, [item]); else list.push(item);
  }
  for (const group of byGroup.keys()) if (!GROUP_ORDER.includes(group)) throw new Error(`Unlisted math palette group: ${group}`);
  const categories = mathEditorLabels().categories;
  const sections = GROUP_ORDER.filter(group => byGroup.has(group)).map(group => {
    const rows = (byGroup.get(group) ?? []).map(item => {
      const example = examplesById.get(item.id);
      if (example === undefined) throw new Error(`Missing math palette example for chapter row: ${item.id}`);
      return mathSymbolsChapterRow(item, example);
    });
    return [`## ${categories[group]}`, '', '| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |', '|---|---|---|---|', ...rows].join('\n');
  });
  const intro = '構造化した数式の入力で使える記号と演算を、分野ごとの表にまとめます。'
    + '「記号／入力の書き方」はその場に挿入される数式、「例」は実際に計算して確かめた入力です。'
    + `詳しい説明は各行の案内、または[${assertPlainCell(mathInputTopic.title, 'math-input title')}](math-input.md)から読めます。`;
  const markdown = ['# 数学記号と演算の一覧', '', intro, '', sections.join('\n\n'), ''].join('\n');
  const violation = findForbiddenHelpTerm(markdown);
  if (violation !== undefined) throw new Error(`Generated math symbols chapter still contains a forbidden help term: ${violation}`);
  return markdown;
}
