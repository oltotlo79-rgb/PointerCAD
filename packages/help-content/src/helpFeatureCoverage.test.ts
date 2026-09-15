import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURE_HELP_BINDINGS } from './featureHelpBindings.js';
import { MANUAL_CHAPTERS } from './manualManifest.js';
import { assertDocumentedFeatureCoverage, buildCommandHelpCoverage, buildHelpFeatureCoverage, parseHelpRequirements } from './helpFeatureCoverage.js';

const table = (body: string): string => '| ID | 要件 | 優先度 |\n| --- | --- | --- |\n' + body;
const requirements = parseHelpRequirements(readFileSync(new URL('../../../docs/requirements.md', import.meta.url), 'utf8'));
const small = parseHelpRequirements(table('| FR-1 | 点を置く | Must |\n| FR-2 | 線を描く | 将来 |'));
const topics = [{ id: 'point', path: 'docs/ja/point.md' }, { id: 'line', path: 'docs/ja/line.md' }];
const bindings = [{ featureId: 'FR-1', topicIds: ['point'] }, { featureId: 'FR-2', topicIds: ['line'] }];

describe('要件と操作から説明の実在する章へ対応付ける', () => {
  it('正本の全行を含み、将来の古い表記と明示統合を落とさず、未作成の説明を可視化する', () => {
    const coverage = buildHelpFeatureCoverage(requirements, MANUAL_CHAPTERS, FEATURE_HELP_BINDINGS);
    expect(coverage.entries.map(entry => entry.id)).toEqual(requirements.map(entry => entry.id));
    expect(coverage.entries.filter(entry => ['FR-313', 'FR-608', 'FR-712', 'FR-808'].includes(entry.id))).toHaveLength(4);
    expect(coverage.entries.filter(entry => ['FR-433', 'FR-434', 'FR-435', 'FR-436'].includes(entry.id))).toHaveLength(4);
    expect(coverage.entries.find(entry => entry.id === 'FR-1103')?.mergedInto).toBe('FR-1107');
    expect(coverage.entries.find(entry => entry.id === 'FR-908')?.topicIds).toContain('display-settings');
    expect(coverage.entries.find(entry => entry.id === 'FR-1004')?.topicIds).toEqual(['offline-use']);
    expect(coverage.pending).toEqual(['FR-1001', 'FR-1002', 'FR-1003']);
    expect(coverage.contentCertified).toBe(false);
    expect(() => assertDocumentedFeatureCoverage(coverage)).toThrow('Undocumented features');
  });
  it('比較表を別の機能として数えず、説明中の縦棒と行番号を保つ', () => {
    const source = table('| FR-1 | 絶対値 |x| を使う | Should |') + '\n\n| ID | 他社 | 違い |\n| FR-99 | 例 | 例 |';
    expect(parseHelpRequirements(source)).toEqual([{ id: 'FR-1', description: '絶対値 |x| を使う', priority: 'Should', sourceLine: 3 }]);
  });
  it('不明な優先度・壊れた行・二重の要件・全行欠落を黙って無視しない', () => {
    expect(() => parseHelpRequirements(table('| FR-1 | 新しい機能 | Unknown |'))).toThrow('Unknown');
    expect(() => parseHelpRequirements(table('| renamed-id | 新しい機能 | Must |'))).toThrow('Unrecognized');
    expect(() => parseHelpRequirements(table('| FR-1 | 点 | Must |\n| FR-1 | 線 | Must |'))).toThrow('Duplicate');
    expect(() => parseHelpRequirements('# 本文のみ')).toThrow('No primary');
  });
  it('空行の後の要件を残し、別の表や本文の後の引用は読み込まない', () => {
    const source = table('| FR-1 | 点 | Must |\n\n  \n| FR-2 | 線 | Should |')
      + '\n\n| ID | 他社 | 違い |\n| FR-99 | 例 | 例 |'
      + '\n\n注記\n| FR-98 | 本文の引用 | Must |';
    expect(parseHelpRequirements(source)).toEqual([
      { id: 'FR-1', description: '点', priority: 'Must', sourceLine: 3 },
      { id: 'FR-2', description: '線', priority: 'Should', sourceLine: 6 },
    ]);
    const prose = table('| FR-1 | 点 | Must |') + '\n\n注記\n| FR-98 | 本文の引用 | Must |';
    expect(parseHelpRequirements(prose).map(requirement => requirement.id)).toEqual(['FR-1']);
  });
  it('要件追加・章削除・古い要件の残置を対応表の見直し前に止める', () => {
    expect(() => buildHelpFeatureCoverage([...small, { id: 'FR-3', sourceLine: 5, description: '面', priority: 'Must' }], topics, bindings)).toThrow('Unassigned');
    expect(() => buildHelpFeatureCoverage(small, topics.slice(0, 1), bindings)).toThrow('Missing help');
    expect(() => buildHelpFeatureCoverage(small.slice(0, 1), topics, bindings)).toThrow('Unknown feature');
  });
  it('同じ件数に見える二重割当と、空・二重の章や未完成状態の混在を断る', () => {
    expect(() => buildHelpFeatureCoverage(small, topics, [bindings[0], bindings[0]])).toThrow('Duplicate feature');
    expect(() => buildHelpFeatureCoverage(small, topics, [{ ...bindings[0], topicIds: [] }, bindings[1]])).toThrow('No help');
    expect(() => buildHelpFeatureCoverage(small, topics, [{ ...bindings[0], topicIds: ['point', 'point'] }, bindings[1]])).toThrow('Duplicate topic');
    expect(() => buildHelpFeatureCoverage(small, topics, [{ ...bindings[0], pending: '未完成' }, bindings[1]])).toThrow('Ambiguous pending');
  });
  it('不存在・自己参照・相互参照の統合先で機能を隠さない', () => {
    for (const target of ['FR-1', 'FR-404']) {
      expect(() => buildHelpFeatureCoverage(small, topics, [{ ...bindings[0], mergedInto: target }, bindings[1]])).toThrow('Invalid merged');
    }
    expect(() => buildHelpFeatureCoverage(small, topics,
      [{ ...bindings[0], mergedInto: 'FR-2' }, { ...bindings[1], mergedInto: 'FR-1' }])).toThrow('Invalid merged');
  });
  it('全説明先が揃った結果でも、本文と実画面の証明を勝手に付けない', () => {
    const result = buildHelpFeatureCoverage(small, topics, bindings);
    expect(() => assertDocumentedFeatureCoverage(result)).not.toThrow();
    expect(result.contentCertified).toBe(false);
    expect(result.entries[0].topicIds).not.toBe(bindings[0].topicIds);
  });
  it('実際の操作一覧の全項目を残し、欠けた説明や重複登録で先へ進めない', () => {
    const commands = [{ id: 'draw.point', helpTopic: 'point' }, { id: 'draw.line', helpTopic: 'line' }];
    expect(buildCommandHelpCoverage(commands, topics)).toEqual([
      { commandId: 'draw.point', topicId: 'point', chapterPath: 'docs/ja/point.md' },
      { commandId: 'draw.line', topicId: 'line', chapterPath: 'docs/ja/line.md' },
    ]);
    expect(() => buildCommandHelpCoverage(commands, topics.slice(0, 1))).toThrow('Undocumented command');
    expect(() => buildCommandHelpCoverage([commands[0], commands[0]], topics)).toThrow('duplicate command');
    expect(() => buildCommandHelpCoverage([], topics)).toThrow('No commands');
  });
});
