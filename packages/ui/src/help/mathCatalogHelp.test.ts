import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findHelpTopic } from '@pointercad/help-content';
import { MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES } from '../math/mathPaletteExamples.js';
import type { MathPaletteCatalogItem, MathPaletteExample } from '../math/mathPaletteGroups.js';
import { buildMathSymbolsChapterMarkdown, mathSymbolsChapterRow } from './mathCatalogHelp.js';

/** 目録から再生成する1つのコマンド（scripts/manual/generateMathSymbolsChapter.mjs）。失敗時の案内文にだけ使う。 */
const REGENERATE_COMMAND = 'node scripts/manual/generateMathSymbolsChapter.mjs';

const mathInputTopic = findHelpTopic('math-input');
if (mathInputTopic === undefined) throw new Error('math-input help topic fixture is missing');
const mathInputTitle = mathInputTopic.title;
const examplesById = new Map(MATH_PALETTE_EXAMPLES.map(example => [example.id, example]));
const dataRowPattern = /^\|(?!---| 名前 ).+\|$/gmu;

const readChapter = (): string => {
  const topic = findHelpTopic('math-symbols');
  if (topic === undefined) throw new Error('math-symbols help topic is not registered in topics.ts');
  return readFileSync(fileURLToPath(new URL(`../../../help-content/${topic.path}`, import.meta.url)), 'utf8');
};

describe('数学記号と演算の一覧(目録から生成する章)', () => {
  it('公開目録の全項目が1回ずつ表になり、名前・例・説明の節が目録と一致する', () => {
    const markdown = buildMathSymbolsChapterMarkdown(MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES);
    const dataRows = markdown.match(dataRowPattern) ?? [];
    expect(dataRows).toHaveLength(MATH_INPUT_PALETTE.length);
    for (const item of MATH_INPUT_PALETTE) {
      const example = examplesById.get(item.id);
      if (example === undefined) throw new Error(`fixture missing example: ${item.id}`);
      expect(markdown, item.id).toContain(mathSymbolsChapterRow(item, example));
    }
  });

  it('章の本文はhelp-content用語検査(topics.test.ts)の禁止語を含まない(「連立一次式」は完全な一語として例外、MC-04b)', () => {
    const markdown = buildMathSymbolsChapterMarkdown(MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES);
    const withoutException = markdown.replaceAll('連立一次式', '');
    for (const term of ['B-rep', 'BRep', '指紋', 'テッセレーション', 'Worker', 'ワーカー', 'XCAF', 'ZIP', 'XML',
      'グループコード', 'ソルバー', 'OCCT', 'OpenCascade', 'JSON', 'IndexedDB', 'キャッシュ', 'ヤコビアン',
      '連立', '四元数', '境界箱', '連結成分']) {
      expect(withoutException, term).not.toContain(term);
    }
    expect(markdown).toContain('連立一次式');
  });

  it('目録から生成した内容と、収録済みの章の本文が一致する(ずれていたら再生成のコマンドを示す)', () => {
    const markdown = buildMathSymbolsChapterMarkdown(MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES);
    expect(readChapter(), `目録から章を再生成してください: ${REGENERATE_COMMAND}`).toBe(markdown);
  });

  it('模擬の新規項目を1件加えると表に反映され、外せば収録済みの章と再び一致する(再生成コマンド1つで追いつく)', () => {
    const fakeItem: MathPaletteCatalogItem = {
      id: 'chapter-self-check-example', group: 'basic', label: '自己点検用の仮項目', symbol: 'selfcheck',
      template: String.raw`\operatorname{selfcheck}\left(#0\right)`, keywords: [], requiredOperations: [],
      acceptanceIds: ['mathPaletteExamples:chapter-self-check-example'], meaning: 'テスト専用の仮項目です。',
      domain: 'テスト専用', argumentTypes: ['real'], resultType: 'real', method: 'native', functionUse: false,
      help: mathInputTitle,
    };
    const fakeExample: MathPaletteExample = { id: 'chapter-self-check-example', selection: '5', slots: [], expected: 5 };
    const augmented = buildMathSymbolsChapterMarkdown([...MATH_INPUT_PALETTE, fakeItem], [...MATH_PALETTE_EXAMPLES, fakeExample]);
    expect(augmented).toContain(mathSymbolsChapterRow(fakeItem, fakeExample));
    expect(augmented.match(dataRowPattern) ?? []).toHaveLength(MATH_INPUT_PALETTE.length + 1);
    expect(augmented).not.toBe(readChapter());
    expect(buildMathSymbolsChapterMarkdown(MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES)).toBe(readChapter());
  });

  it('「連立一次式」を含む名前も元のまま載せ、個別の見出しへ直接リンクする(MC-04b、言い換え・章全体リンクへの置き換えはしない)', () => {
    const linearItem = MATH_INPUT_PALETTE.find(item => item.id === 'linear-solve');
    if (linearItem === undefined) throw new Error('linear-solve is expected to be published');
    const example = examplesById.get('linear-solve');
    if (example === undefined) throw new Error('linear-solve example fixture is missing');
    const row = mathSymbolsChapterRow(linearItem, example);
    expect(row).toContain('連立一次式の一意な解');
    expect(row).not.toContain('一次方程式の組');
    expect(row).toContain('[連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める)');
  });

  it('目録側の不整合(id重複・項目とidの不一致)は例外で止める', () => {
    const [first] = MATH_INPUT_PALETTE;
    if (first === undefined) throw new Error('fixture requires at least one published item');
    expect(() => buildMathSymbolsChapterMarkdown([first, first], MATH_PALETTE_EXAMPLES)).toThrow('Duplicate');
    const otherExample = MATH_PALETTE_EXAMPLES.find(example => example.id !== first.id);
    if (otherExample === undefined) throw new Error('fixture requires a second example');
    expect(() => mathSymbolsChapterRow(first, otherExample)).toThrow('Mismatched');
  });
});
