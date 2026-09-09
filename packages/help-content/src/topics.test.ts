import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findHelpTopic, HELP_TOPICS } from './index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('ヘルプの目録', () => {
  it('目録に載っている Markdown はすべて実在する', () => {
    for (const topic of HELP_TOPICS) {
      expect(existsSync(resolve(packageRoot, topic.path)), topic.path).toBe(true);
    }
  });

  it('id が重複しない', () => {
    const ids = HELP_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('同梱字体の日本語案内とOFL/MITの本文を欠かさない', () => {
    const topic = findHelpTopic('font-licenses');
    if (topic === undefined) throw new Error('字体のライセンス案内がない');
    const text = readFileSync(resolve(packageRoot, topic.path), 'utf8');
    expect(text).toContain('# 字体と解析ライブラリのライセンス');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(text).toContain('Permission is hereby granted');
    expect(text).not.toMatch(/\?{4,}|\uFFFD/);
  });

  it('ビューポートの説明を id で引ける(FR-903 の土台)', () => {
    expect(findHelpTopic('viewport')?.path).toBe('docs/ja/viewport.md');
  });

  it('存在しない id では undefined を返す', () => {
    expect(findHelpTopic('この項目はない')).toBeUndefined();
  });

  it('面と面をつなぐ・ロフトの説明を id で引ける(FR-430、FR-410、P5 タスク27)', () => {
    expect(findHelpTopic('ruled-loft')?.path).toBe('docs/ja/ruled-loft.md');
  });

  it('測定の説明を id で引ける(FR-1102、P5 タスク32)', () => {
    expect(findHelpTopic('measure')?.path).toBe('docs/ja/measure.md');
  });

  it('質量特性の説明を id で引ける(FR-1101、P5 タスク32)', () => {
    expect(findHelpTopic('mass-properties')?.path).toBe('docs/ja/mass-properties.md');
  });

  it('立体の形を変える道具の説明を id で引ける(FR-409、FR-417〜428、P5 タスク52)', () => {
    expect(findHelpTopic('shape-edit')?.path).toBe('docs/ja/shape-edit.md');
  });

  it('平面で切る説明を id で引ける(FR-432、P5 タスク27f)', () => {
    expect(findHelpTopic('cut')?.path).toBe('docs/ja/cut.md');
  });

  it('球の表面に点を置く説明を id で引ける(FR-431、P5 タスク22)', () => {
    expect(findHelpTopic('sphere-grid')?.path).toBe('docs/ja/sphere-grid.md');
  });

  /**
   * 目録の件数(P5 タスク52・27f)。**新しい機能はヘルプを必ず伴う**(NFR-MA-4)ので、
   * 道具を足したのに目録が増えていない取りこぼしをここで止める。
   * P4 完了時 27 + P5 で足した 16(外観 3・画面の見た目・基本形状・球の表面に点を置く・
   * 面をつなぐ/ロフト・測定 2・立体の形を変える・平面で切る ほか)= 43。
   */
  it('目録の件数が数えたとおりになる(NFR-MA-4)', () => {
    // P6 タスク32 で 4 本(書き出す・読み込む・DXF・単位)足して 43 + 4 = 47。
    // P6 タスク43 で 4 本(切って中を見る・選ぶものを絞る・下絵・3D プリントの点検)足して 51。
    // P6 タスク33 で 2 本(ひな形・印刷と別名で保存)足して 53。
    // P7 タスク11bで1本、タスク46・47で操作別に8本を足して53 + 9 = 62。
    // P8の同梱字体・解析ライブラリのライセンスを1本足して63。
    expect(HELP_TOPICS).toHaveLength(63);
  });

  it('アセンブリの説明を id で引ける(FR-601・602・605・606)', () => {
    expect(findHelpTopic('assembly')?.path).toBe('docs/ja/assembly.md');
  });

  it('P7の操作別ヘルプ8本をidで引ける(FR-613・614・617・618、NFR-MA-4)', () => {
    const expected = [
      ['assembly-place', 'assembly-place.md'],
      ['mate', 'mate.md'],
      ['joint', 'joint.md'],
      ['interference', 'interference.md'],
      ['standard-parts', 'standard-parts.md'],
      ['explode', 'explode.md'],
      ['bom', 'bom.md'],
      ['replace-subassembly', 'replace-subassembly.md'],
    ];
    for (const [id, fileName] of expected) {
      expect(findHelpTopic(id)?.path).toBe(`docs/ja/${fileName}`);
    }
  });


  it('アセンブリの説明に直接移動・取消・履歴・保存の境界がある(P7 タスク18)', () => {
    const topic = findHelpTopic('assembly');
    if (topic === undefined) throw new Error('assembly topic required');
    const text = readFileSync(resolve(packageRoot, topic.path), 'utf-8');
    for (const phrase of ['部品を直接動かす', '合致を保てる', 'Esc', '元に戻す', '自動保存']) {
      expect(text, phrase).toContain(phrase);
    }
    expect(text).toContain('引っぱっている途中の位置は文書へ書き込みません');
  });

  it('書き出し・読み込み・DXF・単位の説明を id で引ける(FR-802・803・811・813・814)', () => {
    expect(findHelpTopic('export')?.path).toBe('docs/ja/export.md');
    expect(findHelpTopic('import')?.path).toBe('docs/ja/import.md');
    expect(findHelpTopic('dxf')?.path).toBe('docs/ja/dxf.md');
    expect(findHelpTopic('units')?.path).toBe('docs/ja/units.md');
  });

  it('ひな形・印刷と別名で保存の説明を id で引ける(FR-807・810・812・814、P6 タスク33)', () => {
    expect(findHelpTopic('template')?.path).toBe('docs/ja/template.md');
    expect(findHelpTopic('print-save-as')?.path).toBe('docs/ja/print-save-as.md');
  });

  it('断面表示・選択・下絵・3D プリントの点検の説明を id で引ける(FR-111・112・332・815)', () => {
    expect(findHelpTopic('section-view')?.path).toBe('docs/ja/section-view.md');
    expect(findHelpTopic('selection')?.path).toBe('docs/ja/selection.md');
    expect(findHelpTopic('canvas')?.path).toBe('docs/ja/canvas.md');
    expect(findHelpTopic('print-check')?.path).toBe('docs/ja/print-check.md');
  });
});

/**
 * 利用者向けの文章に出してはいけない言葉(`rules/05-リリース.md` §11.3)。
 *
 * ヘルプは操作の手引きであって設計の文書ではない。内部の作り(データの持ち方・
 * 計算の方式・ファイルの入れ物の仕組み)の名前が 1 語でも混ざると、利用者は
 * 「これは自分が知っておくべきことなのか」を判断できなくなる。
 *
 * **「面」「立体」「三角形」「式」「単位」は利用者が画面で見る言葉なので入れない。**
 * ここに並べるのは、画面に一度も出ない内部の呼び名だけである。
 */
const FORBIDDEN_TERMS: readonly string[] = [
  'B-rep',
  'BRep',
  '指紋',
  'テッセレーション',
  'Worker',
  'ワーカー',
  'XCAF',
  'ZIP',
  'XML',
  'グループコード',
  'ソルバー',
  'OCCT',
  'OpenCascade',
  'JSON',
  'IndexedDB',
  'キャッシュ',
  'ヤコビアン',
  '連立',
  '四元数',
  '境界箱',
  '連結成分',
];

describe('ヘルプの言葉づかい(rules/05 §11.3)', () => {
  it('内部用語が 1 語も出てこない', () => {
    for (const topic of HELP_TOPICS) {
      const text = readFileSync(resolve(packageRoot, topic.path), 'utf-8');
      for (const term of FORBIDDEN_TERMS) {
        expect(text.includes(term), `${topic.path} に「${term}」がある`).toBe(false);
      }
    }
  });
});
