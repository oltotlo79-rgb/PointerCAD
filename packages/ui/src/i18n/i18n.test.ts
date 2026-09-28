import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
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

  it('P7の合致・ジョイント・規格部品・部品表の見出しがすべてそろっている', () => {
    const mateKeys: readonly MessageKey[] = [
      'assembly.tool.mateCoincident', 'assembly.tool.mateConcentric',
      'assembly.tool.mateDistance', 'assembly.tool.mateAngle',
      'assembly.tool.mateParallel', 'assembly.tool.mateTangent',
    ];
    const jointKeys: readonly MessageKey[] = [
      'assembly.tool.jointRevolute', 'assembly.tool.jointSlider',
      'assembly.tool.jointCylindrical', 'assembly.tool.jointBall',
    ];
    const standardPartKeys: readonly MessageKey[] = [
      'assembly.standardPart.hexBolt', 'assembly.standardPart.hexNut',
      'assembly.standardPart.plainWasher', 'assembly.standardPart.springWasher',
      'assembly.standardPart.socketHeadCapScrew', 'assembly.standardPart.panHeadScrew',
      'assembly.standardPart.deepGrooveBallBearing', 'assembly.standardPart.structuralSection',
    ];
    const bomColumnKeys: readonly MessageKey[] = [
      'assembly.bom.column.number', 'assembly.bom.column.name',
      'assembly.bom.column.quantity', 'assembly.bom.column.material',
      'assembly.bom.column.mass',
    ];
    expect(mateKeys).toHaveLength(6);
    expect(jointKeys).toHaveLength(4);
    expect(standardPartKeys).toHaveLength(8);
    expect(bomColumnKeys).toHaveLength(5);
    for (const key of [...mateKeys, ...jointKeys, ...standardPartKeys, ...bomColumnKeys]) {
      expect(t(key).length, key).toBeGreaterThan(0);
    }
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

/**
 * 製品のコードからも説明書(`{{ui:鍵}}`)からも引かれていない文言の鍵(w91a で見つけた時点の残り)。
 * **ここへ足さない。** 新しく使われなくなった鍵は表から消す。ここにある鍵を使い始めたか消したら、
 * この一覧からも消す(一覧は減るだけ)。見た目に出ない文言は、翻訳や点検の手間だけを増やし、
 * 説明書の照合で「画面に無い文言」として紛れる(未使用の `exchange.dwgType` の点検、w65b §3-A)。
 */
const KNOWN_UNUSED_MESSAGE_KEYS: readonly string[] = [
  'commandLine.error.toolNotHere',
  'constraintList.countLabel',
  'constraintList.empty',
  'controlGuide.mathGeometry.tool',
  'exchange.import',
  'functionPoint.unsupported',
  'machiningError.notPlanarFace',
  'mathGeometry.hint',
  'mathGeometry.palette.pending',
  'propertyPanel.coilDiameter',
  'propertyPanel.coordinate.origin',
  'propertyPanel.count',
  'propertyPanel.cutPlane',
  'propertyPanel.diameter',
  'propertyPanel.embossRaised',
  'propertyPanel.patternPlacement',
  'propertyPanel.planeAngle',
  'propertyPanel.planeAzimuth',
  'propertyPanel.planeOffset',
  'propertyPanel.planeTilt',
  'propertyPanel.primitiveCenterCoordinate',
  'propertyPanel.radius',
  'propertyPanel.scaleFactor',
  'propertyPanel.sectionPoints',
  'propertyPanel.shellOutward',
  'propertyPanel.spacing',
  'propertyPanel.springLength',
  'propertyPanel.springPitch',
  'propertyPanel.springTurns',
  'propertyPanel.sweepFrenet',
  'propertyPanel.taperOutward',
  'propertyPanel.threadLength',
  'propertyPanel.transformTranslation',
  'propertyPanel.wireDiameter',
  'settings.lengthUnit',
  'settings.lengthUnitInch',
  'settings.lengthUnitMillimeter',
  'springError.pitchTooSmall',
  'springError.tooManyTurns',
  'springError.wireTooThick',
  'statusBar.unit',
];

/** 文言の鍵を引いている製品のコード(検査・検査用の補助を除く)の本文と、説明書の `{{ui:鍵}}` を集める。 */
function usedMessageKeys(): { readonly literals: ReadonlySet<string>; readonly prefixes: readonly string[] } {
  const repositoryRoot = resolve(sourceRoot, '../../..');
  const sources: string[] = [];
  for (const group of ['packages', 'apps']) {
    for (const entry of readdirSync(join(repositoryRoot, group), { withFileTypes: true })) {
      const source = join(repositoryRoot, group, entry.name, 'src');
      if (!entry.isDirectory() || !existsSync(source)) continue;
      for (const extension of ['.ts', '.tsx', '.mts']) {
        for (const file of listFiles(source, extension)) {
          if (/\.test\.[cm]?tsx?$/u.test(file) || /[\\/]testing[\\/]/u.test(file)) continue;
          sources.push(readFileSync(file, 'utf8'));
        }
      }
    }
  }
  const code = sources.join('\n');
  const manual = listFiles(join(repositoryRoot, 'packages/help-content/docs/ja'), '.md')
    .map((file) => readFileSync(file, 'utf8')).join('\n');
  const literals = new Set<string>([
    ...Array.from(code.matchAll(/['"`]([A-Za-z][\w.-]*)['"`]/gu), (match) => match[1]),
    ...Array.from(manual.matchAll(/\{\{ui:([^{}]+)\}\}/gu), (match) => match[1]),
  ]);
  // `math.palette.${id}.label` や 'drawing.error.' + kind のように組み立てる鍵は、決まった頭の部分で見る。
  const prefixes = [
    ...Array.from(code.matchAll(/`([A-Za-z][\w.-]*)\$\{/gu), (match) => match[1]),
    ...Array.from(code.matchAll(/['"]([A-Za-z][\w.-]*)['"]\s*\+/gu), (match) => match[1]),
  ];
  return { literals, prefixes };
}

/**
 * モデルブラウザの「⋮」一覧(部品・アセンブリの木)の項目の、名前と説明(title)の抜けを探す(w91a)。
 * 説明を「押せないときだけ」付ける書き方(`title={cond ? undefined : …}`)も抜けとして数える。
 */
function menuItemsWithoutDescription(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (opening !== null) {
      const attributes = opening.attributes.properties.filter(ts.isJsxAttribute);
      const attribute = (name: string) => attributes.find((item) => item.name.getText(source) === name);
      if (attribute('role')?.initializer?.getText(source) === '"menuitem"') {
        const line = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1;
        const title = attribute('title')?.initializer;
        const titleText = title === undefined ? '' : title.getText(source);
        if (titleText === '' || titleText === '""' || /\b(undefined|null)\b/u.test(titleText)) problems.push(`${line}: title`);
        const named = attribute('aria-label') !== undefined
          || (ts.isJsxElement(node) && node.children.some((child) => !ts.isJsxText(child) || child.getText(source).trim() !== ''));
        if (!named) problems.push(`${line}: name`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

describe('モデルブラウザの「⋮」一覧の項目は名前と説明を持つ(w91a、FR-904)', () => {
  it.each(['shell/FeatureTree.tsx', 'shell/AssemblyTree.tsx', 'shell/PropertyPanel.tsx'])('%s', (file) => {
    const path = join(sourceRoot, file);
    expect(menuItemsWithoutDescription(path, readFileSync(path, 'utf8'))).toEqual([]);
  });
  it('説明の無い項目と、押せないときだけ説明を付ける書き方を抜けとして見つける(検査そのものの確認)', () => {
    const probe = [
      'const a = <button role="menuitem" title={blocked ? undefined : t(key)}>{t(label)}</button>;',
      'const b = <button role="menuitem">{t(label)}</button>;',
      'const c = <button role="menuitem" title={t(hint)} />;',
      'const d = <button role="menuitem" title={t(hint)}>{t(label)}</button>;',
    ].join('\n');
    expect(menuItemsWithoutDescription('probe.tsx', probe)).toEqual(['1: title', '2: title', '3: name']);
  });
});

describe('使われていない文言の鍵を残さない(w91a)', () => {
  it('どの鍵も製品のコードか説明書から引かれている(見つけた時点の残りは一覧のとおりで、増やさない)', () => {
    const { literals, prefixes } = usedMessageKeys();
    const unused = MESSAGE_KEYS.filter((key) => !literals.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)));
    expect([...unused].sort(), '使われていない鍵を足したか、一覧の鍵を使い始めた・消した。表と一覧をそろえる').toEqual(
      [...KNOWN_UNUSED_MESSAGE_KEYS].sort());
    expect(MESSAGE_KEYS).not.toContain('exchange.dwgType');
  });
});
