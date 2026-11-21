/**
 * コマンドラインの構文解析と道具の語の表 (FR-208)。
 *
 * 空行は段の確定を表す。それ以外は名前付きの欄、スケッチの道具、立体の道具、選びの語、座標の順に調べる。
 * スケッチの 23 道具には道具 ID を、立体の 26 道具にはツールバーの命令 ID を返す。
 * ストアへの反映と命令の実行は commandLineActions.ts が受け持つ。
 *
 * 入力する語は自分の道具の日本語名・英語名と、その短縮から作る。スケッチでは例えば
 * 選択は select の s、点列は point array の pa、2点円弧と3点の円弧は ta と tpa、
 * 直線配列と円形配列は array と polar array から ar と par を使う。
 * 立体では、短い英語名はそのまま、長い単語は先頭の 3 字、複数の単語は各語の頭文字を使う。
 * スケッチと名前が重なる道具は「立体のミラー」や solidfillet のように区別する。
 * 大文字・小文字をそろえ、語全体が一致したときだけ道具を決める。
 *
 * words は入力として受け付ける綴りを保持する。表示にはツールバーと同じ labelKey を使う。
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

import type { ToolbarCommandId } from '../commands/toolbarCommandCatalog.js';
import { t, type MessageKey } from '../i18n/t.js';

import type {
  ClickEditToolId,
  EditToolId,
  NumericInputToolId,
  ShapeToolId,
  SketchToolId,
} from './numericInput.js';

/** コマンドラインが道具の切替として受け付ける道具。 */
export type CommandToolId = SketchToolId | ShapeToolId | EditToolId | ClickEditToolId;

/** 道具 1 つの語(日本語・英語・短縮)。一覧はこのファイルの 1 か所だけ。 */
export interface CommandWord<Tool extends string = CommandToolId> {
  readonly tool: Tool;
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

interface SolidCommandWord extends Pick<CommandWord, 'labelKey' | 'words'> {
  readonly commandId: ToolbarCommandId;
}

/** 部品の「作る」「合わせる」「加工」へ届く語。 */
export const SOLID_COMMAND_WORDS: readonly SolidCommandWord[] = [
  { commandId: 'toolbar.solidCreate.extrude', labelKey: 'toolbar.solid.extrude', words: ['押し出し', 'extrude', 'ext'] },
  { commandId: 'toolbar.solidCreate.revolve', labelKey: 'toolbar.solid.revolve', words: ['回転', 'revolve', 'rev'] },
  { commandId: 'toolbar.solidCreate.sew', labelKey: 'toolbar.solid.sew', words: ['縫合', 'sew'] },
  { commandId: 'toolbar.solidCombine.union', labelKey: 'toolbar.solid.union', words: ['和', 'union', 'uni'] },
  { commandId: 'toolbar.solidCombine.subtract', labelKey: 'toolbar.solid.subtract', words: ['差', 'subtract', 'sub'] },
  { commandId: 'toolbar.solidCombine.intersect', labelKey: 'toolbar.solid.intersect', words: ['積', 'intersect', 'int'] },
  { commandId: 'toolbar.solidCreate.sphere', labelKey: 'toolbar.solid.sphere', words: ['球', 'sphere', 'sph'] },
  { commandId: 'toolbar.solidCreate.box', labelKey: 'toolbar.solid.box', words: ['箱', 'box'] },
  { commandId: 'toolbar.solidCreate.cylinder', labelKey: 'toolbar.solid.cylinder', words: ['円柱', 'cylinder', 'cyl'] },
  { commandId: 'toolbar.solidCreate.cone', labelKey: 'toolbar.solid.cone', words: ['円錐', 'cone'] },
  { commandId: 'toolbar.solidCreate.torus', labelKey: 'toolbar.solid.torus', words: ['トーラス', 'torus', 'tor'] },
  { commandId: 'toolbar.solidCreate.ruled', labelKey: 'toolbar.solid.ruled', words: ['面をつなぐ', 'ruled', 'rul'] },
  { commandId: 'toolbar.solidCreate.loft', labelKey: 'toolbar.solid.loft', words: ['ロフト', 'loft'] },
  { commandId: 'toolbar.solidCreate.mirrorSolid', labelKey: 'toolbar.solid.mirror', words: ['立体のミラー', 'mirrorsolid', 'ms'] },
  { commandId: 'toolbar.solidCreate.sweep', labelKey: 'toolbar.solid.sweep', words: ['スイープ', 'sweep', 'swe'] },
  { commandId: 'toolbar.solidCreate.spring', labelKey: 'toolbar.solid.spring', words: ['ばね', 'spring', 'spr'] },
  { commandId: 'toolbar.solidMachining.hole', labelKey: 'toolbar.machining.hole', words: ['穴', 'hole'] },
  { commandId: 'toolbar.solidMachining.threadHole', labelKey: 'toolbar.machining.threadHole', words: ['ねじ穴', 'threadhole', 'th'] },
  { commandId: 'toolbar.solidMachining.fillet', labelKey: 'toolbar.machining.fillet', words: ['R面取り', 'solidfillet', 'sf'] },
  { commandId: 'toolbar.solidMachining.chamfer', labelKey: 'toolbar.machining.chamfer', words: ['C面取り', 'solidchamfer', 'sc'] },
  { commandId: 'toolbar.solidMachining.linearPattern', labelKey: 'toolbar.machining.linearPattern', words: ['直線パターン', 'linearpattern', 'lp'] },
  { commandId: 'toolbar.solidMachining.circularPattern', labelKey: 'toolbar.machining.circularPattern', words: ['円形パターン', 'circularpattern', 'cp'] },
  { commandId: 'toolbar.solidMachining.shell', labelKey: 'toolbar.machining.shell', words: ['くり抜き', 'shell', 'she'] },
  { commandId: 'toolbar.solidMachining.draft', labelKey: 'toolbar.machining.draft', words: ['抜き勾配', 'draft', 'dra'] },
  { commandId: 'toolbar.solidMachining.rib', labelKey: 'toolbar.machining.rib', words: ['リブ', 'rib'] },
  { commandId: 'toolbar.solidMachining.cut', labelKey: 'toolbar.machining.cut', words: ['切断', 'cut'] },
];

/** 選びの語(M06-2)が選ぶもの。直前に作った立体・全部の立体・選択の解除。 */
export type CommandSelectTarget = 'last' | 'all' | 'none';

/** 選びの語の頭の語。「選ぶ 直前」「sel last」のように、対象の語と空白で区切って打つ。 */
const SELECT_HEAD_WORDS: readonly string[] = ['選ぶ', 'sel'];

/** 選びの語の対象の語(日本語・英語)。 */
const SELECT_TARGET_WORDS: ReadonlyMap<string, CommandSelectTarget> = new Map([
  ['直前', 'last'], ['last', 'last'], ['全部', 'all'], ['all', 'all'], ['解除', 'none'], ['none', 'none'],
]);

/** 選びの語の打ち方の例(断る時の候補)。 */
const SELECT_EXAMPLES: readonly string[] = ['sel last', 'sel all', 'sel none'];

/** 候補の tool は、一覧の各ボタンを識別するために画面でも使う。 */
type SuggestedWord = CommandWord<CommandToolId | ToolbarCommandId>;

const SUGGESTION_WORDS: readonly SuggestedWord[] = [
  ...COMMAND_WORDS,
  ...SOLID_COMMAND_WORDS.map(({ commandId, labelKey, words }) => ({ tool: commandId, labelKey, words })),
];

/** 名前付きの欄の単文字の別名(「r=5 / d=20 / a=30 / l=100」)。1 か所だけに置く。 */
const FIELD_KEY_ALIASES: Readonly<Record<string, string>> = {
  r: 'radius',
  d: 'diameter',
  a: 'angle',
  l: 'length',
  // 元の要件文の例(r=5, d=3, n=6)に合わせて、個数の別名も足した(必須の語の表には無いが、
  // 同じ考えの自然な拡張。`CommandLine.tsx` が current の欄名と突き合わせて使う)。
  n: 'count',
};

/**
 * コマンドラインが受け取る手掛かり(`context` 引数)。
 * 3D スケッチ(`plane` が null)では極座標が使えない(既存の `resolveCoordinate.ts` と同じ制約)。
 */
export interface CommandLineContext {
  readonly plane: WorkPlane | null;
  readonly variables: ReadonlyMap<string, number>;
  readonly exactVariables?: ReadonlyMap<string, string>;
  readonly nonLengthVariables?: ReadonlySet<string>;
  /** 直前の点があるか(`@` を使えるか、FR-302)。 */
  readonly hasPrevious: boolean;
}

export type CommandLineOutcome =
  | { readonly kind: 'tool'; readonly tool: NumericInputToolId }
  | { readonly kind: 'command'; readonly commandId: ToolbarCommandId }
  /** 立体を選ぶ(M06-2)。直前に作った立体・全部の立体・解除。 */
  | { readonly kind: 'select'; readonly target: CommandSelectTarget }
  /** いま開いている段の座標の欄を埋める。 */
  | { readonly kind: 'coordinate'; readonly value: CoordinateInput }
  /** いま開いている段の名前付きの欄を埋める(r=5 / d=20 / a=30 / l=100)。 */
  | { readonly kind: 'field'; readonly fieldKey: string; readonly source: string }
  /** 段を確定する(空の Enter)。 */
  | { readonly kind: 'commit' }
  | { readonly kind: 'error'; readonly message: string; readonly suggestions: readonly string[] };

// ---------------------------------------------------------------------------
// 全角の正規化。式の共通正規化に加え、構造判定用の @ ＜ ＝ も扱うため、
// このファイルの中に専用の表を持つ。数字・演算子の正規化は evaluateExpression 自身が
// もう一度行うので二重になるが、
// この関数の役目は「道具の語か座標か欄名かを見分けるための、ここでの構造判定」であり、
// その判定より前に @ ＜ ＝ を半角へ直しておく必要がある(「2 文字だけ足す」を、
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
  // ここから下 3 文字が、式エンジンの表に無いのでこのファイルが足すぶん。
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
// 括弧の深さを数えながらの分割(「root(8,3), 5」が壊れないようにする)。
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

/** 深さ0にある最初の1文字の位置。無ければ -1(「最初の括弧の外の `<` だけで分ける」)。 */
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

/** 打ちかけの語に前方一致する道具(最大 5 件)。 */
export function suggestCommands(input: string, limit = 5): readonly SuggestedWord[] {
  const normalized = normalizeCommandLineSource(input.trim()).toLowerCase();
  if (normalized === '') {
    return [];
  }
  return SUGGESTION_WORDS.filter((entry) =>
    entry.words.some(word => word.toLowerCase().startsWith(normalized)),
  ).slice(0, Math.max(0, Math.min(limit, 5)));
}

/** 表示・提案用に、道具のいちばん短い語を選ぶ(短縮を優先して見せる)。 */
function shortestWord(entry: SuggestedWord): string {
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
// 座標の組み立て。
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
    const result = evaluateExpression(raw.trim(), context);
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

  const distanceResult = evaluateExpression(distanceSource, context);
  if (!distanceResult.ok) {
    return errorOutcome(distanceResult.error.message, []);
  }
  const angleResult = evaluateExpression(angleSource, context);
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
      // コマンドラインの極座標は平面内だけを書く記法なので仰角は常に 0。
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
 * 選びの語(M06-2)。頭の語(選ぶ・sel)で始まらなければ null。頭の語の後の対象が 1 つの決まった語でなければ、
 * 打ち方の例を添えて断る(道具の語の候補を出すと、選びの語を打った人には関係の無い候補になるため)。
 */
function parseSelectWords(lower: string): CommandLineOutcome | null {
  const [head, target, ...rest] = lower.split(/\s+/u);
  if (head === undefined || !SELECT_HEAD_WORDS.includes(head)) return null;
  const chosen = target === undefined || rest.length > 0 ? undefined : SELECT_TARGET_WORDS.get(target);
  return chosen === undefined ? errorOutcome(t('commandLine.error.selectTarget'), SELECT_EXAMPLES) : { kind: 'select', target: chosen };
}

/**
 * コマンドラインの1行を解く(FR-208)。欄への流し込み・段への確定は `CommandLine.tsx` が行う。
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

  const solid = SOLID_COMMAND_WORDS.find(entry => entry.words.some(word => word.toLowerCase() === lower));
  if (solid !== undefined) {
    return { kind: 'command', commandId: solid.commandId };
  }

  const select = parseSelectWords(lower);
  if (select !== null) {
    return select;
  }

  if (looksLikeCoordinate(normalized)) {
    return parseCoordinateLike(normalized, context);
  }

  return errorOutcome(t('commandLine.error.noSuchTool'), errorSuggestions(lower));
}
