/**
 * コマンドラインの構文解析と道具の語の表(計画書 docs/plans/P4b-スケッチの仕上げ.md タスク17、
 * §0.a-0.8〜0.11、§2.5。FR-208)。
 *
 * ここは純関数だけで、DOM にも React にも Zustand ストアにも触れない。
 * 打った文字列を「道具の切替」「いま開いている段の座標の欄」「名前付きの欄」「段の確定」
 * のどれかへ翻訳するだけで、`numericInput.ts` の段の定義には一切触れない(§0.a-0.9)。
 * 欄への流し込み・候補の表示・段への配線はタスク18(`CommandLine.tsx`)の役目。
 *
 * **対象にする道具(§0.a-0.10、計画書 タスク17 の「この表は網羅ではない」の指示への回答)**:
 * `SketchToolId + ShapeToolId + EditToolId + ClickEditToolId` の 23 種だけを対象にした
 * (計画書の推奨どおり)。ソリッドの道具(`SolidToolId` 10 種)・基準ジオメトリ
 * (`ReferenceToolId` 7 種)・立体から取り込む 2 種(`PickEditToolId`)は対象外(FR-208 の目的が
 * キーボードだけでの作図であるため)。
 *
 * **語の割り当て**: 計画書が明示した 17 道具(線分・円・円弧・点・矩形・正多角形・長穴・楕円・
 * スプライン・複写・ミラー・オフセット・トリム・延長・フィレット・面取り・面)はその表のとおり。
 * 残り 6 道具(選択・点列・2点円弧・3点の円弧・直線配列・円形配列)は AutoCAD に直接の相当が
 * 無いため、次のとおり自分で決めた(短縮の頭文字が他と重ならないことは検査で固定する)。
 * - 選択: `s`(実際の AutoCAD の既定の acad.pgp に `S` の割り当ては無く、自由に使える)。
 * - 点列: `pa`(point array。単独の点は `po` を使っているため)。
 * - 2点円弧: `ta`(two-point arc)。
 * - 3点の円弧: `tpa`(three-point arc)。
 * - 直線配列: `ar`(array。CLAUDE.md の指示にある「AR=配列」を直線側の既定に割り当てた)。
 * - 円形配列: `par`(polar array)。
 *
 * なお「点」の短縮は計画書タスク17 の表がすでに `po` としており、実物の AutoCAD の
 * `acad.pgp` も `PO,*POINT`(POINT の既定の別名は PO)なので、計画書の表を正とした。
 *
 * **道具の語を ja.json に置かない理由**: 語(`words`)は「打つ文字列」であって表示ではない。
 * 表示名は `labelKey` で `ja.json` から引く(既存の `toolbar.tool.*`)。両者を混同しない。
 */

import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionValue,
} from '@pointercad/expression';
import {
  addVec3,
  planeToWorld,
  scaleVec3,
  type CoordinateInput,
  type PointReference,
  type WorkPlane,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';

import type {
  ClickEditToolId,
  EditToolId,
  NumericInputToolId,
  ShapeToolId,
  SketchToolId,
} from './numericInput.js';

/** コマンドラインが道具の切替として受け付ける道具(§0.a-0.10 の推奨どおりの範囲)。 */
export type CommandToolId = SketchToolId | ShapeToolId | EditToolId | ClickEditToolId;

/** 道具 1 つの語(日本語・英語・短縮)。一覧はこのファイルの 1 か所だけ(§0.a-0.10 の②)。 */
export interface CommandWord {
  readonly tool: CommandToolId;
  /** 表示に使う名前。ツールバーの labelKey と同じものを指す(`toolbar.tool.*`)。 */
  readonly labelKey: MessageKey;
  /** 打てる語。判定は小文字へ直してから行うので、大文字小文字はどちらで書いてもよい。 */
  readonly words: readonly string[];
}

/**
 * 道具の語の表(正本、1 か所だけ)。
 * `copy` 道具(平行移動の複写)は `toolbar.tool.copyMove`(「複写」)を表示名に使う。
 * `toolbar.tool.copy`(「複製」)はツールバーの畳んだ一覧では使っていない別のキーなので、
 * ここでは使わない(`toolbarMenus.ts` の `EDIT_MENU_ITEMS` の 'copy' 項目と同じ labelKey に揃えた)。
 */
export const COMMAND_WORDS: readonly CommandWord[] = [
  { tool: 'select', labelKey: 'toolbar.tool.select', words: ['選択', 'select', 's'] },
  { tool: 'point', labelKey: 'toolbar.tool.point', words: ['点', 'point', 'po'] },
  { tool: 'line', labelKey: 'toolbar.tool.line', words: ['線分', 'line', 'l'] },
  { tool: 'arc', labelKey: 'toolbar.tool.arc', words: ['円弧', 'arc', 'a'] },
  { tool: 'pointArray', labelKey: 'toolbar.tool.pointArray', words: ['点列', 'pointarray', 'pa'] },
  { tool: 'face', labelKey: 'toolbar.tool.face', words: ['面', 'face', 'fa'] },
  { tool: 'circle', labelKey: 'toolbar.tool.circle', words: ['円', 'circle', 'c'] },
  {
    tool: 'twoPointArc',
    labelKey: 'toolbar.tool.twoPointArc',
    words: ['2点円弧', 'twopointarc', 'ta'],
  },
  {
    tool: 'threePointArc',
    labelKey: 'toolbar.tool.threePointArc',
    words: ['3点の円弧', 'threepointarc', 'tpa'],
  },
  {
    tool: 'rectangle',
    labelKey: 'toolbar.tool.rectangle',
    words: ['矩形', '長方形', 'rectangle', 'rec'],
  },
  {
    tool: 'polygon',
    labelKey: 'toolbar.tool.polygon',
    words: ['正多角形', '多角形', 'polygon', 'pol'],
  },
  { tool: 'slot', labelKey: 'toolbar.tool.slot', words: ['長穴', 'slot', 'sl'] },
  { tool: 'ellipse', labelKey: 'toolbar.tool.ellipse', words: ['楕円', 'ellipse', 'el'] },
  { tool: 'spline', labelKey: 'toolbar.tool.spline', words: ['スプライン', 'spline', 'spl'] },
  { tool: 'offset', labelKey: 'toolbar.tool.offset', words: ['オフセット', 'offset', 'o'] },
  { tool: 'mirror', labelKey: 'toolbar.tool.mirror', words: ['ミラー', '鏡像', 'mirror', 'mi'] },
  { tool: 'copy', labelKey: 'toolbar.tool.copyMove', words: ['複写', 'copy', 'co'] },
  {
    tool: 'linearArray',
    labelKey: 'toolbar.tool.linearArray',
    words: ['直線配列', 'lineararray', 'ar'],
  },
  {
    tool: 'circularArray',
    labelKey: 'toolbar.tool.circularArray',
    words: ['円形配列', 'circulararray', 'par'],
  },
  { tool: 'sketchFillet', labelKey: 'toolbar.tool.sketchFillet', words: ['フィレット', 'fillet', 'f'] },
  { tool: 'sketchChamfer', labelKey: 'toolbar.tool.sketchChamfer', words: ['面取り', 'chamfer', 'cha'] },
  { tool: 'trim', labelKey: 'toolbar.tool.trim', words: ['トリム', 'trim', 'tr'] },
  { tool: 'extend', labelKey: 'toolbar.tool.extend', words: ['延長', 'extend', 'ex'] },
];

/** 名前付きの欄の単文字の別名(§2.5「r=5 / d=20 / a=30 / l=100」)。1 か所だけに置く。 */
const FIELD_KEY_ALIASES: Readonly<Record<string, string>> = {
  r: 'radius',
  d: 'diameter',
  a: 'angle',
  l: 'length',
  // 元の要件文の例(r=5, d=3, n=6)に合わせて、個数の別名も足した(計画書の必須表には無いが、
  // 同じ考えの自然な拡張。task18 が current の欄名と突き合わせて使う)。
  n: 'count',
};

/**
 * コマンドラインが受け取る手掛かり(計画書 §2.5 の `context` 引数)。
 * 3D スケッチ(`plane` が null)では極座標が使えない(既存の `resolveCoordinate.ts` と同じ制約)。
 */
export interface CommandLineContext {
  readonly plane: WorkPlane | null;
  readonly variables: ReadonlyMap<string, number>;
  /** 直前の点があるか(`@` を使えるか、FR-302)。 */
  readonly hasPrevious: boolean;
}

export type CommandLineOutcome =
  | { readonly kind: 'tool'; readonly tool: NumericInputToolId }
  /** いま開いている段の座標の欄を埋める。 */
  | { readonly kind: 'coordinate'; readonly value: CoordinateInput }
  /** いま開いている段の名前付きの欄を埋める(r=5 / d=20 / a=30 / l=100)。 */
  | { readonly kind: 'field'; readonly fieldKey: string; readonly source: string }
  /** 段を確定する(空の Enter)。 */
  | { readonly kind: 'commit' }
  | { readonly kind: 'error'; readonly message: string; readonly suggestions: readonly string[] };

// ---------------------------------------------------------------------------
// 全角の正規化(§2.5。normalizeExpressionSource は @pointercad/expression の公開 API に
// 無い(index.ts が輸出していない、内部の作りを隠す方針)ため、同じ考えでこのファイルの中に
// 1 つだけ持つ。数字・演算子の正規化は evaluateExpression 自身がもう一度行うので二重になるが、
// この関数の役目は「道具の語か座標か欄名かを見分けるための、ここでの構造判定」であり、
// その判定より前に @ ＜ ＝ を半角へ直しておく必要がある(§2.5 の「2 文字だけ足す」を、
// 欄名の＝も同じ理由で 1 つ足して 3 文字にした)。
// ---------------------------------------------------------------------------

const NORMALIZE_MAP: ReadonlyMap<string, string> = new Map([
  ['０', '0'], ['１', '1'], ['２', '2'], ['３', '3'], ['４', '4'],
  ['５', '5'], ['６', '6'], ['７', '7'], ['８', '8'], ['９', '9'],
  ['．', '.'], ['，', ','],
  ['＋', '+'], ['－', '-'], ['−', '-'],
  ['×', '*'], ['＊', '*'], ['÷', '/'], ['／', '/'],
  ['（', '('], ['）', ')'], ['＾', '^'],
  ['　', ' '],
  // ここから下 3 文字が、式エンジンの表に無いのでこのファイルが足すぶん(§2.5)。
  ['＠', '@'],
  ['＜', '<'],
  ['＝', '='],
]);

function normalizeCommandLineSource(source: string): string {
  let normalized = '';
  for (const character of source) {
    normalized += NORMALIZE_MAP.get(character) ?? character;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// 括弧の深さを数えながらの分割(§2.5「root(8,3), 5」が壊れないようにする)。
// ---------------------------------------------------------------------------

/** 深さ0にある `,` だけで分ける。関数呼び出しの引数の `,` を巻き込まない。 */
function splitTopLevelComma(source: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const character = source.charAt(i);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      if (depth > 0) {
        depth -= 1;
      }
    } else if (character === ',' && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** 深さ0にある最初の1文字の位置。無ければ -1(§2.5「最初の括弧の外の `<` だけで分ける」)。 */
function findTopLevelCharacter(source: string, target: string): number {
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const character = source.charAt(i);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      if (depth > 0) {
        depth -= 1;
      }
    } else if (character === target && depth === 0) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 道具の語の判定・候補
// ---------------------------------------------------------------------------

function findToolByWord(word: string): CommandToolId | null {
  for (const entry of COMMAND_WORDS) {
    if (entry.words.some((candidate) => candidate.toLowerCase() === word)) {
      return entry.tool;
    }
  }
  return null;
}

/** 打ちかけの語に前方一致する道具(最大 5 件、§0.a-0.11)。 */
export function suggestCommands(input: string, limit = 5): readonly CommandWord[] {
  const normalized = normalizeCommandLineSource(input.trim()).toLowerCase();
  if (normalized === '') {
    return [];
  }
  const matches: CommandWord[] = [];
  for (const entry of COMMAND_WORDS) {
    if (entry.words.some((word) => word.toLowerCase().startsWith(normalized))) {
      matches.push(entry);
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return matches;
}

/** 表示・提案用に、道具のいちばん短い語を選ぶ(短縮を優先して見せる)。 */
function shortestWord(entry: CommandWord): string {
  return entry.words.reduce((shortest, word) => (word.length < shortest.length ? word : shortest));
}

/**
 * 道具の語として見つからなかったときの提案。まず打った文字列そのもので前方一致を試し、
 * 見つからなければ最初の1文字だけで試す(`LL` のような打ちすぎでも `l`(線分)を示せるようにする)。
 */
function errorSuggestions(lowerInput: string): readonly string[] {
  const direct = suggestCommands(lowerInput, 5);
  if (direct.length > 0) {
    return direct.map(shortestWord);
  }
  const firstCharacter = lowerInput.charAt(0);
  if (firstCharacter === '') {
    return [];
  }
  return suggestCommands(firstCharacter, 5).map(shortestWord);
}

function errorOutcome(message: string, suggestions: readonly string[]): CommandLineOutcome {
  return { kind: 'error', message, suggestions };
}

// ---------------------------------------------------------------------------
// 座標の組み立て(§2.5)。
// ---------------------------------------------------------------------------

/** 分けた成分が座標らしいかどうか(道具の語の判定に失敗した後、最後にこれで振り分ける)。 */
function looksLikeCoordinate(source: string): boolean {
  if (splitTopLevelComma(source).length > 1) {
    return true;
  }
  const first = source.charAt(0);
  return (
    first === '@' ||
    first === '<' ||
    first === '.' ||
    first === '-' ||
    first === '(' ||
    (first >= '0' && first <= '9')
  );
}

/**
 * 絶対座標を組み立てる。作図面があれば作図面の (u, v) をワールドへ直す(`planeToWorld`)。
 * ワールド座標は「決まった瞬間の数」として `expressionValueFromNumber` で包む
 * (ビューポートのクリックで入った座標 FR-107 と同じ扱い。NFR-RE-4「丸めは最終段だけ」の
 * 最終段はここ)。3D スケッチ(作図面なし)では打った式をそのまま x/y/z に使う。
 */
function buildAbsolute(
  values: readonly ExpressionValue[],
  plane: WorkPlane | null,
): CoordinateInput {
  if (plane === null) {
    const [x, y, z] = values;
    return { mode: 'absolute', x, y, z };
  }
  const [u, v] = values;
  const world = planeToWorld(plane, u.value, v.value);
  return {
    mode: 'absolute',
    x: expressionValueFromNumber(world[0]),
    y: expressionValueFromNumber(world[1]),
    z: expressionValueFromNumber(world[2]),
  };
}

/**
 * 相対座標(ずれ)を組み立てる。`resolveCoordinate.ts` は dx/dy/dz を基準点へそのまま
 * ワールド空間で足すので(平面変換をしない)、作図面があるときは打った (du, dv) を
 * ここで axisU・axisV に沿ったワールドのずれへ直しておく(原点は足さない。ずれだからである)。
 */
function buildRelative(
  values: readonly ExpressionValue[],
  plane: WorkPlane | null,
): CoordinateInput {
  const base: PointReference = { kind: 'previous' };
  if (plane === null) {
    const [dx, dy, dz] = values;
    return { mode: 'relative', base, dx, dy, dz };
  }
  const [du, dv] = values;
  const delta = addVec3(scaleVec3(plane.axisU, du.value), scaleVec3(plane.axisV, dv.value));
  return {
    mode: 'relative',
    base,
    dx: expressionValueFromNumber(delta[0]),
    dy: expressionValueFromNumber(delta[1]),
    dz: expressionValueFromNumber(delta[2]),
  };
}

/** 絶対・相対(`,` 区切り、`<` を含まない)を解く。 */
function parseAbsoluteOrRelative(
  body: string,
  hasAt: boolean,
  context: CommandLineContext,
): CommandLineOutcome {
  const rawParts = splitTopLevelComma(body);
  const needed = context.plane === null ? 3 : 2;

  if (rawParts.some((part) => part.trim() === '')) {
    return errorOutcome(t('commandLine.error.tooFewValues'), []);
  }
  if (rawParts.length > needed) {
    return errorOutcome(t('commandLine.error.tooManyValues'), []);
  }
  if (rawParts.length < needed) {
    return errorOutcome(t('commandLine.error.tooFewValues'), []);
  }

  const values: ExpressionValue[] = [];
  for (const raw of rawParts) {
    const result = evaluateExpression(raw.trim(), { variables: context.variables });
    if (!result.ok) {
      return errorOutcome(result.error.message, []);
    }
    values.push(result.value);
  }

  const value = hasAt ? buildRelative(values, context.plane) : buildAbsolute(values, context.plane);
  return { kind: 'coordinate', value };
}

/** 極座標(`@距離<角度`)を解く。`angleIndex` は深さ0の `<` の位置。 */
function parsePolar(body: string, angleIndex: number, hasAt: boolean, context: CommandLineContext): CommandLineOutcome {
  const distanceSource = body.slice(0, angleIndex).trim();
  const angleSource = body.slice(angleIndex + 1).trim();

  if (distanceSource === '') {
    return errorOutcome(t('commandLine.error.missingDistance'), []);
  }
  if (!hasAt) {
    return errorOutcome(t('commandLine.error.missingAtPrefix'), []);
  }
  if (angleSource === '') {
    return errorOutcome(t('commandLine.error.missingAngle'), []);
  }
  if (context.plane === null) {
    // 3D スケッチには角度の基準になる作図面が無い(resolveCoordinate.ts と同じ制約)。
    return errorOutcome(t('commandLine.error.polarNot3d'), []);
  }

  const distanceResult = evaluateExpression(distanceSource, { variables: context.variables });
  if (!distanceResult.ok) {
    return errorOutcome(distanceResult.error.message, []);
  }
  const angleResult = evaluateExpression(angleSource, { variables: context.variables });
  if (!angleResult.ok) {
    return errorOutcome(angleResult.error.message, []);
  }

  return {
    kind: 'coordinate',
    value: {
      mode: 'polar',
      base: { kind: 'previous' },
      distance: distanceResult.value,
      azimuth: angleResult.value,
      // コマンドラインの極座標は平面内だけを書く記法なので仰角は常に 0(§2.5)。
      elevation: expressionValueFromNumber(0),
    },
  };
}

function parseCoordinateLike(source: string, context: CommandLineContext): CommandLineOutcome {
  const hasAt = source.startsWith('@');
  const body = hasAt ? source.slice(1) : source;

  if (hasAt && !context.hasPrevious) {
    return errorOutcome(t('commandLine.error.missingPrevious'), []);
  }

  const angleIndex = findTopLevelCharacter(body, '<');
  if (angleIndex !== -1) {
    return parsePolar(body, angleIndex, hasAt, context);
  }
  return parseAbsoluteOrRelative(body, hasAt, context);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const FIELD_PATTERN = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/;

/**
 * コマンドラインの1行を解く(FR-208)。欄への流し込み・段への確定はタスク18 が行う。
 */
export function parseCommandLine(input: string, context: CommandLineContext): CommandLineOutcome {
  const firstTrim = input.trim();
  if (firstTrim === '') {
    return { kind: 'commit' };
  }

  const normalized = normalizeCommandLineSource(firstTrim).trim();
  if (normalized === '') {
    return { kind: 'commit' };
  }

  const fieldMatch = FIELD_PATTERN.exec(normalized);
  if (fieldMatch !== null) {
    const rawKey = fieldMatch[1].toLowerCase();
    const fieldSource = fieldMatch[2].trim();
    if (fieldSource === '') {
      return errorOutcome(t('commandLine.error.missingFieldValue'), []);
    }
    const fieldKey = FIELD_KEY_ALIASES[rawKey] ?? rawKey;
    return { kind: 'field', fieldKey, source: fieldSource };
  }

  const lower = normalized.toLowerCase();
  const tool = findToolByWord(lower);
  if (tool !== null) {
    return { kind: 'tool', tool };
  }

  if (looksLikeCoordinate(normalized)) {
    return parseCoordinateLike(normalized, context);
  }

  return errorOutcome(t('commandLine.error.noSuchTool'), errorSuggestions(lower));
}
