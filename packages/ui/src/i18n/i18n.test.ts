import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, type MessageKey, t } from './t.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 日本語(ひらがな・カタカナ・漢字・全角記号)と判定するコードポイント範囲。
 * ESLint の no-irregular-whitespace が全角スペース(U+3000)などの
 * 空白類文字リテラルを検査対象にするため、正規表現の文字クラスではなく
 * 数値のコードポイント範囲として持つ。
 */
const JAPANESE_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // 区切り記号・句読点
  [0x3040, 0x309f], // ひらがな
  [0x30a0, 0x30ff], // カタカナ
  [0x4e00, 0x9fff], // 漢字
  [0xff00, 0xffef], // 全角英数・記号
];

function containsJapanese(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (JAPANESE_CODE_POINT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
      return true;
    }
  }
  return false;
}

function listFiles(directory: string, extension: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(fullPath, extension));
    } else if (entry.name.endsWith(extension)) {
      found.push(fullPath);
    }
  }
  return found;
}

/** 注釈は日本語で書いてよいので、判定の前に取り除く。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('UI 文字列リソース(NFR-MA-5)', () => {
  it('キーが 1 件以上あり、すべて空でない文字列を返す', () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThan(0);
    for (const key of MESSAGE_KEYS) {
      expect(t(key).length, key).toBeGreaterThan(0);
    }
  });

  it('区画の見出しとステータスバーの案内が定義されている(FR-905)', () => {
    expect(t('featureTree.title')).toBe('モデルブラウザ');
    expect(t('propertyPanel.title')).toBe('プロパティ');
    expect(t('statusBar.unit')).toBe('単位: mm');
  });

  it('ビューキューブの 6 面の表記が揃っている(FR-103)', () => {
    expect([
      t('viewCube.front'),
      t('viewCube.back'),
      t('viewCube.right'),
      t('viewCube.left'),
      t('viewCube.top'),
      t('viewCube.bottom'),
    ]).toEqual(['前', '後', '右', '左', '上', '下']);
  });

  it('表示の単位の札が mm / inch の 2 つそろっている(FR-811、P6 タスク3)', () => {
    // mm 側は P5 までの固定の札とまったく同じ文字にしてある(見た目を変えない)。
    expect(t('statusBar.unitMillimeter')).toBe('単位: mm');
    expect(t('statusBar.unitInch')).toBe('単位: inch');
    expect(t('statusBar.unitHint').length).toBeGreaterThan(0);
  });

  it('入出力の断りの文言は ui が組み立てる 5 つだけ(P6 タスク5、統括の決定 2026-09-06)', () => {
    /*
     * §2.8 の断りの表のうち、**kernel / io が日本語の文そのものを組み立てて返すもの**
     * (`DXF_UNSUPPORTED_FORMAT_MESSAGE` など、読み込みの失敗・壊れたファイル・大きすぎる形)は
     * ここに置かない。同じ文が 2 か所にあると片方だけ直したときに食い違うため(統括の決定)。
     *
     * 残すのは **`@pointercad/model` の `ExportNoticeKey` が返す 5 つ**だけで、model は
     * キーを返し文言は持たない(`exchange/types.ts` の注釈)。**名前は `ExportNoticeKey` と
     * 1 対 1 にそろえてある**ので、パネル(タスク32)は対応表を 1 つ書くだけで済む。
     */
    const keys = MESSAGE_KEYS.filter((key) => key.startsWith('exchangeError.'));
    expect(keys).toEqual([
      'exchangeError.nothingToExport',
      'exchangeError.shellNotSupported',
      'exchangeError.meshNotSupported',
      'exchangeError.colorNotSupported',
      'exchangeError.qualityIgnored',
    ]);
    for (const key of keys) {
      expect(t(key).length, key).toBeGreaterThan(0);
    }
  });

  it('ファイルの種別の説明が 8 種そろっている(P6 タスク4・5)', () => {
    // `.pcad` だけは P2 からある `file.typeDescription` をそのまま使う(鍵を増やさない)。
    const descriptions = [
      t('file.typeDescription'),
      t('file.type.template'),
      t('file.type.step'),
      t('file.type.stl'),
      t('file.type.obj'),
      t('file.type.gltf'),
      t('file.type.threeMf'),
      t('file.type.dxf'),
    ];
    expect(descriptions.length).toBe(8);
    expect(new Set(descriptions).size).toBe(8);
  });

  it('アセンブリの断りの文言が 21 件そろっている(P7 §2.12、NFR-MA-5)', () => {
    /*
     * 計画書 P7 §2.12 の表(21 行)を**1 字も変えずに**写したもの。順番も表のとおり。
     *
     * 表が数を含む 3 件だけは `{min}` / `{max}` / `{value}` / `{total}` / `{count}` の
     * 差し込みにしてある(数は場面ごとに変わるため)。**差し込んだ結果が表の文と
     * 1 字も違わない**ことをここで固定するので、表と食い違えば落ちる
     * (差し込みの書き方は `sketch/constraintActions.ts` と同じ `replace`)。
     */
    const table: readonly (readonly [MessageKey, string])[] = [
      ['assemblyError.sameComponent', '同じ部品には合致を付けられません。'],
      [
        'assemblyError.curvedFace',
        'この面は合致に使えません。平らな面か円筒の面を選んでください。',
      ],
      ['assemblyError.noAxis', 'この形からは軸が決まりません。'],
      [
        'assemblyError.nearParallelAngle',
        'この角度では合致を付けられません。『平行』を使ってください。',
      ],
      [
        'assemblyError.negativeDistance',
        '距離は 0 以上にしてください。向きは『裏返す』で変えられます。',
      ],
      ['assemblyError.conflictingMates', 'この合致は同時には成り立ちません。'],
      ['assemblyError.redundantMates', '同じ条件が重なっています。'],
      ['assemblyError.fixedComponentDrag', 'この部品は固定されています。固定を外すと動かせます。'],
      [
        'assemblyError.tooManyComponents',
        '組める部品が多すぎます(上限 100 個)。組を入れ子にして分けてください。',
      ],
      [
        'assemblyError.noFixedComponent',
        '動かない部品がありません。1 つを固定すると位置が決まります。',
      ],
      ['assemblyError.jointRangeEnd', '可動範囲の端です({min}〜{max})。'],
      ['assemblyError.jointOutOfRange', '可動範囲の外です({min}〜{max}、いま {value})。'],
      ['assemblyError.selfContained', 'このアセンブリは自分自身を含んでいます。'],
      ['assemblyError.tooDeep', '組の入れ子が深すぎます(8 段まで)。'],
      [
        'assemblyError.partFileMissing',
        '元のファイルが見つかりません。取り込んだ形で開いています。',
      ],
      ['assemblyError.partFileUpdated', '部品が更新されています。取り込み直しますか。'],
      [
        'assemblyError.replaceUnmatchedMates',
        '合致 {total} 本のうち {count} 本が選び直せませんでした。そのまま差し替えますか。',
      ],
      ['assemblyError.interferenceFailed', 'この組の食い込みを測れませんでした。'],
      ['assemblyError.unknownStandardSize', 'この呼び寸法は用意されていません。'],
      ['assemblyError.noComponentsToCheck', '調べる部品がありません。'],
      ['assemblyError.editPartInAssembly', '部品の形はその部品を開いて直してください。'],
    ];
    expect(table.length).toBe(21);
    for (const [key, text] of table) {
      expect(t(key), key).toBe(text);
    }
    // 数を差し込むと、表に載っている例の文とちょうど同じになる。
    expect(
      t('assemblyError.jointRangeEnd').replace('{min}', '30°').replace('{max}', '120°'),
    ).toBe('可動範囲の端です(30°〜120°)。');
    expect(
      t('assemblyError.jointOutOfRange')
        .replace('{min}', '30°')
        .replace('{max}', '120°')
        .replace('{value}', '145°'),
    ).toBe('可動範囲の外です(30°〜120°、いま 145°)。');
    expect(
      t('assemblyError.replaceUnmatchedMates').replace('{total}', 'N').replace('{count}', 'M'),
    ).toBe('合致 N 本のうち M 本が選び直せませんでした。そのまま差し替えますか。');
    // 表の 21 件のほかに ui が持つのは、部品として開けなかったときの言い換え 1 件だけ
    // (io の「この形式の種類(assembly)にはまだ対応していません」は P7 では正しくない)。
    const keys = MESSAGE_KEYS.filter((key) => key.startsWith('assemblyError.'));
    expect(keys.length).toBe(22);
    expect(t('assemblyError.isAssemblyFile')).toBe('このファイルはアセンブリです。');
  });

  it('コンポーネント(.tsx)へ日本語を直書きしていない', () => {
    const offenders: string[] = [];
    for (const file of listFiles(sourceRoot, '.tsx')) {
      if (containsJapanese(stripComments(readFileSync(file, 'utf8')))) {
        offenders.push(file);
      }
    }
    expect(offenders, 'ja.json へ移してください').toEqual([]);
  });
});
