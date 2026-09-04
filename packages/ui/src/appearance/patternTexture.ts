/**
 * 柄(手続き的テクスチャ、FR-1108)を `THREE.CanvasTexture` として作る(計画書
 * docs/plans/P5-高度なソリッド・外観と測定.md §2.4.3、タスク8)。
 *
 * 統括の指示(このタスクの依頼書)により、実装は次の3段に分ける。
 *
 * 1. `patternDrawCommands` / `patternAlphaDrawCommands` — Canvas 2D の命令を「描く」
 *    のではなく「データとして列挙する」純関数。three にも DOM にも触れないので Node で
 *    検査できる(乱数を使わないことも、この列を2回作って同じになることで固定できる)。
 * 2. `drawPattern` — その命令の列を、実際の描画道具(`PatternRenderingContext2D`。
 *    `CanvasRenderingContext2D` が構造的にそのまま渡せる最小限の形)へ適用する。
 *    偽の道具(呼ばれた命令を記録するだけの物)を渡せば Node でも検査できる
 *    (`createTrackingLayer.ts` 同様、この ui パッケージには jsdom を入れない方針
 *    `themeColors.ts` 冒頭の注釈)。
 * 3. `createPatternTexture` — 実際に `document.createElement('canvas')` を呼ぶ、
 *    環境に依存する薄い皮。**canvas が無い環境(Node の検査、Web Worker 等)では
 *    必ず `null` を返し、例外を投げない。**
 *
 * 先行タスク1が `packages/model/src/appearance/types.ts` に `AppearancePattern` を
 * 作っているが、`model/src/index.ts` からはまだ輸出されていない(タスク2でまとめる)ため、
 * このファイルは model の型に依存せず、`PatternKind` という自分だけの文字列の union
 * (`AppearancePattern.kind` と同じ4つの値)で受ける。タスク9で
 * `AppearanceSpec.pattern.kind` → `PatternKind` への詰め替えを行う(申し送り)。
 *
 * **乱数を使わない**(§2.4.3)。同じ文書を開き直したときに同じ絵が出るようにするため、
 * 木目のゆらぎも周期の異なる正弦波3本の和で作る(`Math.random` を1つも呼ばない)。
 *
 * **タイルの継ぎ目を合わせる**(手順3)。エキスパンドメタルの対角線は、隣のタイルへ
 * ちょうどつながる角度(45°/135°)で引き、木目の年輪は「タイル1枚 = 年輪1本ぶんの
 * 間隔」になるよう y 方向にちょうど1周期の正弦波で作る(`woodGrainWobble` の注釈を参照)。
 * 縞鋼板の突起はタイルの内側(1/4・3/4の位置)に収め、縁からはみ出させないことで
 * 継ぎ目の食い違いを避ける。
 *
 * **繰り返しの間隔(mm)は、タイルの絵そのものには影響しない。** `texture.repeat` を
 * 変えるだけで実寸を変える設計(§0.a-0.6)なので、`spacing` は `patternRepeatFor` を
 * 通してタスク9・10が使う(1枚が表す実寸は `spacing` そのもの。ピクセル数には依らない)。
 */

import * as THREE from 'three';

/** タイルの一辺の画素数。§2.4.3 の決定どおり 512。 */
export const PATTERN_TEXTURE_SIZE = 512;

/**
 * 柄の種類。`AppearancePattern`(`packages/model/src/appearance/types.ts`)の
 * `kind` と同じ4つの文字列(`'none'` は柄なし)。タスク9で model の型からここへ詰め替える。
 */
export type PatternKind = 'none' | 'expandedMetal' | 'checkerPlate' | 'woodGrain';

/**
 * `drawPattern` が呼ぶ Canvas 2D の道具の最小限。実際には `CanvasRenderingContext2D` が
 * そのまま渡せる(構造的に上位互換のため、`as` は不要)。Node の検査では、この形だけを
 * 満たす偽の道具を渡して呼ばれた命令を記録する。
 */
export interface PatternRenderingContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void;
}

/** Canvas 2D の描画命令を、呼び出しではなくデータとして表したもの(Node で検査できる)。 */
export type PatternDrawCommand =
  | { readonly op: 'fillStyle'; readonly value: string }
  | { readonly op: 'strokeStyle'; readonly value: string }
  | { readonly op: 'lineWidth'; readonly value: number }
  | { readonly op: 'beginPath' }
  | { readonly op: 'moveTo'; readonly x: number; readonly y: number }
  | { readonly op: 'lineTo'; readonly x: number; readonly y: number }
  | { readonly op: 'stroke' }
  | { readonly op: 'fill' }
  | {
      readonly op: 'fillRect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly op: 'ellipse';
      readonly x: number;
      readonly y: number;
      readonly radiusX: number;
      readonly radiusY: number;
      readonly rotation: number;
      readonly startAngle: number;
      readonly endAngle: number;
    };

/** `patternDrawCommands` / `patternAlphaDrawCommands` へ渡す設定。 */
export interface PatternDrawOptions {
  /** タイルの一辺の画素数。検査では小さい値(64 等)も使う。実際は `PATTERN_TEXTURE_SIZE`。 */
  readonly size: number;
  /** 木目の地の色(`#rrggbb`)。`kind === 'woodGrain'` のときだけ使う。 */
  readonly baseColor?: string;
  /** 木目の木目の色(`#rrggbb`)。`kind === 'woodGrain'` のときだけ使う。 */
  readonly grainColor?: string;
}

// ---------------------------------------------------------------------------
// エキスパンドメタル・縞鋼板の色(実際の材質の色には依らない、無彩色の陰影)。
// `material.map` として base の色へ掛け合わされる想定なので、色相を持たせない
// (どの色のプリセットにも同じテクスチャを使い回せる)。
// ---------------------------------------------------------------------------

const EXPANDED_METAL_BASE_COLOR = '#8c9199';
const EXPANDED_METAL_STRAND_COLOR = '#e2e5e9';
/** alphaMap 用。桟が白(不透明)・穴が黒(透明)(§0.a-0.8)。 */
const ALPHA_HOLE_COLOR = '#000000';
const ALPHA_STRAND_COLOR = '#ffffff';

const CHECKER_PLATE_BASE_COLOR = '#9a9a9a';
const CHECKER_PLATE_HIGHLIGHT_COLOR = '#e8e8e8';
const CHECKER_PLATE_SHADOW_COLOR = '#5a5a5a';

/** 樹種の色が渡されなかったときの後退値(ナラ相当。呼び出し側は必ず渡す想定)。 */
const DEFAULT_WOOD_BASE_COLOR = '#cbab7d';
const DEFAULT_WOOD_GRAIN_COLOR = '#9c7a4a';

/** 桟の幅は1タイルの1/6(§2.4.3)。 */
const EXPANDED_METAL_STRAND_FRACTION = 1 / 6;

/**
 * 菱形の網目(エキスパンドメタルの色/穴の両方の元)。対角線をタイルの外(-size〜2size)まで
 * 余分に引くことで、`RepeatWrapping` で並べたときに隣のタイルへ切れ目なくつながる。
 */
function diamondLatticeCommands(
  size: number,
  backgroundColor: string,
  strandColor: string,
): readonly PatternDrawCommand[] {
  const strandWidth = size * EXPANDED_METAL_STRAND_FRACTION;
  const offsets = [-size, 0, size, size * 2];
  const commands: PatternDrawCommand[] = [
    { op: 'fillStyle', value: backgroundColor },
    { op: 'fillRect', x: 0, y: 0, width: size, height: size },
    { op: 'strokeStyle', value: strandColor },
    { op: 'lineWidth', value: strandWidth },
  ];
  for (const offset of offsets) {
    commands.push({ op: 'beginPath' });
    commands.push({ op: 'moveTo', x: offset, y: 0 });
    commands.push({ op: 'lineTo', x: offset + size, y: size });
    commands.push({ op: 'stroke' });
  }
  for (const offset of offsets) {
    commands.push({ op: 'beginPath' });
    commands.push({ op: 'moveTo', x: offset, y: size });
    commands.push({ op: 'lineTo', x: offset + size, y: 0 });
    commands.push({ op: 'stroke' });
  }
  return commands;
}

/**
 * 縞鋼板: 1タイルに4本の楕円形の突起を交互の向き(0°/90°)で置き、影(右下へずらした暗い
 * 楕円)と本体(左上へずらした明るい楕円)の2枚重ねで立体に見せる。突起はタイルの内側
 * (1/4・3/4の位置)に収め、縁からはみ出させないことで継ぎ目の食い違いを避ける。
 */
function checkerPlateCommands(size: number): readonly PatternDrawCommand[] {
  const bumpRadiusX = size * 0.18;
  const bumpRadiusY = size * 0.09;
  const shadowOffset = size * 0.03;
  const bumps: ReadonlyArray<{ readonly x: number; readonly y: number; readonly rotation: number }> = [
    { x: size * 0.25, y: size * 0.25, rotation: 0 },
    { x: size * 0.75, y: size * 0.25, rotation: Math.PI / 2 },
    { x: size * 0.25, y: size * 0.75, rotation: Math.PI / 2 },
    { x: size * 0.75, y: size * 0.75, rotation: 0 },
  ];
  const commands: PatternDrawCommand[] = [
    { op: 'fillStyle', value: CHECKER_PLATE_BASE_COLOR },
    { op: 'fillRect', x: 0, y: 0, width: size, height: size },
  ];
  for (const bump of bumps) {
    commands.push({ op: 'fillStyle', value: CHECKER_PLATE_SHADOW_COLOR });
    commands.push({ op: 'beginPath' });
    commands.push({
      op: 'ellipse',
      x: bump.x + shadowOffset,
      y: bump.y + shadowOffset,
      radiusX: bumpRadiusX,
      radiusY: bumpRadiusY,
      rotation: bump.rotation,
      startAngle: 0,
      endAngle: Math.PI * 2,
    });
    commands.push({ op: 'fill' });
    commands.push({ op: 'fillStyle', value: CHECKER_PLATE_HIGHLIGHT_COLOR });
    commands.push({ op: 'beginPath' });
    commands.push({
      op: 'ellipse',
      x: bump.x - shadowOffset,
      y: bump.y - shadowOffset,
      radiusX: bumpRadiusX,
      radiusY: bumpRadiusY,
      rotation: bump.rotation,
      startAngle: 0,
      endAngle: Math.PI * 2,
    });
    commands.push({ op: 'fill' });
  }
  return commands;
}

/** 木目のゆらぎ。周期の異なる正弦波3本の和(乱数を使わない)。 */
interface WoodWobbleTerm {
  readonly cycles: number;
  readonly amplitudeRatio: number;
  readonly phase: number;
}

const WOOD_GRAIN_WOBBLE_TERMS: readonly WoodWobbleTerm[] = [
  { cycles: 3, amplitudeRatio: 0.01, phase: 0 },
  { cycles: 7, amplitudeRatio: 0.006, phase: 1.3 },
  { cycles: 13, amplitudeRatio: 0.003, phase: 2.7 },
];

/**
 * y(画素)におけるゆらぎの量(画素)。`cycles` はすべて整数なので、`y` が `0` から `size`
 * まで動くとき各項の位相はちょうど `cycles` 周ぶん回って戻る。つまり
 * `woodGrainWobble(0, size) === woodGrainWobble(size, size)` が常に成り立ち、
 * 年輪の位置がタイルの上端と下端でちょうどつながる(継ぎ目が合う)。
 */
function woodGrainWobble(y: number, size: number): number {
  const phase = (y / size) * Math.PI * 2;
  let wobble = 0;
  for (const term of WOOD_GRAIN_WOBBLE_TERMS) {
    wobble += Math.sin(phase * term.cycles + term.phase) * size * term.amplitudeRatio;
  }
  return wobble;
}

/** タイルの高さ方向に引く帯の本数。継ぎ目の検査のため `size` を割り切る必要はない
 *  (帯ごとの色は連続な式から作るので、帯の境目が多少ずれても色は連続に近い)。 */
const WOOD_GRAIN_ROW_COUNT = 48;

/** `#rrggbb` を r/g/b の整数へ。 */
function hexToRgb(hex: string): readonly [number, number, number] {
  const normalized = hex.replace('#', '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function channelToHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

/** 2つの `#rrggbb` を `t`(0〜1)で線形補間する(木目の年輪の色を作る)。 */
function mixHexColor(colorA: string, colorB: string, t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const [redA, greenA, blueA] = hexToRgb(colorA);
  const [redB, greenB, blueB] = hexToRgb(colorB);
  const red = redA + (redB - redA) * clamped;
  const green = greenA + (greenB - greenA) * clamped;
  const blue = blueA + (blueB - blueA) * clamped;
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`;
}

/**
 * 木目: `sin(距離 × 2π / 年輪間隔 + ゆらぎ)` を横方向へ引き伸ばして(= 行ごとに横一線に
 * 塗って)年輪を描く。「タイル1枚 = 年輪1本ぶんの間隔」になるよう、y が `0`〜`size` で
 * ちょうど1周期の正弦波にする。
 */
function woodGrainCommands(size: number, baseColor: string, grainColor: string): readonly PatternDrawCommand[] {
  const rowStep = Math.max(1, Math.round(size / WOOD_GRAIN_ROW_COUNT));
  const commands: PatternDrawCommand[] = [
    { op: 'fillStyle', value: baseColor },
    { op: 'fillRect', x: 0, y: 0, width: size, height: size },
  ];
  for (let y = 0; y < size; y += rowStep) {
    const wobble = woodGrainWobble(y, size);
    const ringPhase = ((y + wobble) / size) * Math.PI * 2;
    const mix = (Math.sin(ringPhase) + 1) / 2;
    commands.push({ op: 'fillStyle', value: mixHexColor(baseColor, grainColor, mix) });
    commands.push({ op: 'fillRect', x: 0, y, width: size, height: rowStep });
  }
  return commands;
}

/**
 * 柄1タイルぶんの描画命令の列(色のテクスチャ用)。乱数を使わない純関数なので、同じ引数
 * なら何度呼んでも同じ列になる(`patternTexture.test.ts` で固定)。
 */
export function patternDrawCommands(kind: PatternKind, options: PatternDrawOptions): readonly PatternDrawCommand[] {
  switch (kind) {
    case 'none':
      return [];
    case 'expandedMetal':
      return diamondLatticeCommands(options.size, EXPANDED_METAL_BASE_COLOR, EXPANDED_METAL_STRAND_COLOR);
    case 'checkerPlate':
      return checkerPlateCommands(options.size);
    case 'woodGrain':
      return woodGrainCommands(
        options.size,
        options.baseColor ?? DEFAULT_WOOD_BASE_COLOR,
        options.grainColor ?? DEFAULT_WOOD_GRAIN_COLOR,
      );
    default: {
      const exhaustiveCheck: never = kind;
      return exhaustiveCheck;
    }
  }
}

/**
 * エキスパンドメタルの抜き(桟が白・穴が黒)。`alphaMap` に使う(§0.a-0.8)。
 * エキスパンドメタル以外は `null`(alphaMap が要らないことを表す)。
 */
export function patternAlphaDrawCommands(
  kind: PatternKind,
  options: PatternDrawOptions,
): readonly PatternDrawCommand[] | null {
  if (kind !== 'expandedMetal') {
    return null;
  }
  return diamondLatticeCommands(options.size, ALPHA_HOLE_COLOR, ALPHA_STRAND_COLOR);
}

/**
 * 描画命令の列を、実際の描画道具(`PatternRenderingContext2D`)へ適用する。
 * three にも DOM にも依存しないので、Node の検査では偽の道具を渡して呼ばれた命令を
 * 確かめられる。
 */
export function drawPattern(context: PatternRenderingContext2D, commands: readonly PatternDrawCommand[]): void {
  for (const command of commands) {
    switch (command.op) {
      case 'fillStyle':
        context.fillStyle = command.value;
        break;
      case 'strokeStyle':
        context.strokeStyle = command.value;
        break;
      case 'lineWidth':
        context.lineWidth = command.value;
        break;
      case 'beginPath':
        context.beginPath();
        break;
      case 'moveTo':
        context.moveTo(command.x, command.y);
        break;
      case 'lineTo':
        context.lineTo(command.x, command.y);
        break;
      case 'stroke':
        context.stroke();
        break;
      case 'fill':
        context.fill();
        break;
      case 'fillRect':
        context.fillRect(command.x, command.y, command.width, command.height);
        break;
      case 'ellipse':
        context.ellipse(
          command.x,
          command.y,
          command.radiusX,
          command.radiusY,
          command.rotation,
          command.startAngle,
          command.endAngle,
        );
        break;
      default: {
        const exhaustiveCheck: never = command;
        return exhaustiveCheck;
      }
    }
  }
}

/** `createPatternTexture` へ渡す設定。間隔(mm)はここでは扱わない(`patternRepeatFor` 参照)。 */
export interface PatternCreateOptions {
  /** 木目の地の色(`#rrggbb`)。`kind === 'woodGrain'` のときだけ使う。 */
  readonly baseColor?: string;
  /** 木目の木目の色(`#rrggbb`)。`kind === 'woodGrain'` のときだけ使う。 */
  readonly grainColor?: string;
}

export interface PatternTextureResult {
  readonly texture: THREE.CanvasTexture;
  /** エキスパンドメタルだけ非 `null`(§0.a-0.8)。 */
  readonly alphaTexture: THREE.CanvasTexture | null;
}

/** 使い回しの鍵。柄の種類と(木目なら)樹種の色だけで決まる。間隔(mm)は含めない
 *  (タイルの絵そのものは間隔に依らず、`texture.repeat` は使う側(タスク9・10)が
 *  `patternRepeatFor` で都度計算して反映するため。§2.4.3「512×512のCanvasTextureを
 *  1種類につき1枚だけ作り、使い回す」)。 */
export function patternCacheKey(kind: PatternKind, options: PatternCreateOptions): string {
  return [kind, options.baseColor ?? '', options.grainColor ?? ''].join('|');
}

/**
 * 繰り返しの間隔(mm)を `texture.repeat` の値へ直す。UV は箱投影で mm の座標そのもの
 * (§0.7)なので、`1 / spacingMm` を掛ければ「タイル1枚がちょうど spacingMm mm になる」
 * (FR-1108「模様の大きさを数式で指定」)。
 *
 * 導出例(縞鋼板、間隔20mm): 1枚のテクスチャが表す実寸は spacingMm の値そのもの、
 * つまり **20mm**(テクスチャの画素数(512px)には依らない。画素数は解像度であって
 * 実寸の元ではないため)。`texture.repeat` に入れる値は `1 / 20 = 0.05`。
 */
export function patternRepeatFor(spacingMm: number): number {
  return 1 / spacingMm;
}

const patternTextureCache = new Map<string, PatternTextureResult>();

/**
 * 柄の `CanvasTexture` を作る(環境に canvas があるときだけ)。同じ引数(柄の種類 +
 * 樹種の色)では同じ結果を返す(使い回し。§2.4.3)。Node の検査環境のように
 * `document.createElement` が使えない環境、または `'2d'` の描画道具が取れない環境では
 * `null` を返し、例外は投げない。
 */
export function createPatternTexture(kind: PatternKind, options: PatternCreateOptions = {}): PatternTextureResult | null {
  if (kind === 'none') {
    return null;
  }

  const key = patternCacheKey(kind, options);
  const cached = patternTextureCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    // canvas の無い環境(Node の検査、Web Worker 等)。実描画はしない設計(このタスクの依頼書)。
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = PATTERN_TEXTURE_SIZE;
  canvas.height = PATTERN_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context === null) {
    return null;
  }

  const drawOptions: PatternDrawOptions = {
    size: PATTERN_TEXTURE_SIZE,
    baseColor: options.baseColor,
    grainColor: options.grainColor,
  };
  drawPattern(context, patternDrawCommands(kind, drawOptions));

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // 色のテクスチャだけ sRGB(alphaMap は色ではないので既定のまま。手順4)。
  texture.colorSpace = THREE.SRGBColorSpace;

  let alphaTexture: THREE.CanvasTexture | null = null;
  const alphaCommands = patternAlphaDrawCommands(kind, drawOptions);
  if (alphaCommands !== null) {
    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width = PATTERN_TEXTURE_SIZE;
    alphaCanvas.height = PATTERN_TEXTURE_SIZE;
    const alphaContext = alphaCanvas.getContext('2d');
    if (alphaContext !== null) {
      drawPattern(alphaContext, alphaCommands);
      alphaTexture = new THREE.CanvasTexture(alphaCanvas);
      alphaTexture.wrapS = THREE.RepeatWrapping;
      alphaTexture.wrapT = THREE.RepeatWrapping;
    }
  }

  const result: PatternTextureResult = { texture, alphaTexture };
  patternTextureCache.set(key, result);
  return result;
}

/** 使い回しの表からすべて捨てる(§4「three.js で作った…資源は必ず dispose() する」)。
 *  この後の `createPatternTexture` 呼び出しは、鍵が同じでも作り直す。 */
export function disposePatternTextures(): void {
  for (const result of patternTextureCache.values()) {
    result.texture.dispose();
    result.alphaTexture?.dispose();
  }
  patternTextureCache.clear();
}
