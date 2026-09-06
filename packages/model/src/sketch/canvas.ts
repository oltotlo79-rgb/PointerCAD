/**
 * 下絵の画像の受け入れと 2 点の寸法合わせ(FR-332「読み込んだ画像を作図面に置いて、
 * 2 点で寸法を合わせ、その上をなぞってスケッチできる」)。
 * 計画書 docs/plans/P6-入出力.md §0.a-0.45、§0.a-0.46、§2.14、タスク38。
 *
 * ここに置くのは**純関数だけ**で、DOM にも three.js にも `Image` にも触れない
 * (画像を復号して画素の幅・高さを測るのは `packages/ui` タスク39 の仕事。Node の検査で
 * 動かせるように、ここはバイト列と数だけを見る)。
 *
 * **画像そのものを `.pcad` へ保存するのは `rules/04`「導出できるものは保存しない」の
 * 承認済みの例外**である(§0.a-0.45 の例外③、統括の承認)。読み込んだ画像は**再計算では
 * 導出できない**——元のファイルが手元から消えたら二度と作れない——ので、読み込んだ B-rep
 * (§0.a-0.9)・読み込んだ三角形(§0.a-0.24)とまったく同じ理屈で `.pcad` に抱き込む。
 * 文書(`part/types.ts` の `SketchCanvas`)が持つのは id と寸法だけで、バイト列は
 * ZIP の別エントリ(`canvases/<imageId>.png`)へ入れる。
 *
 * **断りの文言をこの層に置く理由**(§2.8「文言の正本の層」、統括の決定 2026-09-06):
 * 上限の 8MB を知っているのはこの層だけなので、文言を `packages/ui` の `ja.json` へ
 * 写すと、上限を変えたときに数字が 2 か所で食い違う。読み込んだ形の「大きすぎる」
 * (kernel / io が組み立てて返す文)と同じ扱いにそろえてある。
 */

import type { SketchCanvas } from '../part/types.js';

/** 下絵として受け付ける画像の形式(§0.a-0.45)。ブラウザが必ず読める 2 つに絞る。 */
export type CanvasImageFormat = 'png' | 'jpeg';

/**
 * 1 枚あたりの上限(バイト)。**8MB**(§0.a-0.45)。
 *
 * 根拠は NFR-PF-6(メモリ)と `.pcad` の大きさで、画像は圧縮済みのまま ZIP へ入る
 * (`packages/io` の `ATTACHMENT_IMAGE_LEVEL` は 0)ので、この値がそのまま
 * ファイルの増分の上限になる。
 */
export const MAX_CANVAS_IMAGE_BYTES = 8 * 1024 * 1024;

/** 上の値を MB で表した数(文言に埋め込むためだけに使う。数の正本は上の定数)。 */
const MAX_CANVAS_IMAGE_MEGABYTES = MAX_CANVAS_IMAGE_BYTES / 1024 / 1024;

/** PNG / JPEG のどちらでもない画像を渡されたときの断り(§2.8 の表)。 */
export const CANVAS_UNSUPPORTED_FORMAT_MESSAGE = '対応していない画像です。';

/** 上限を超えた画像を渡されたときの断り(§2.8 の表)。上限の数は定数から埋める。 */
export const CANVAS_TOO_LARGE_MESSAGE = `画像が大きすぎます。${String(
  MAX_CANVAS_IMAGE_MEGABYTES,
)}MB までにしてください。`;

/** 2 点の寸法合わせで、2 点が同じ位置だったときの断り(§2.14 の表。0 除算の防止)。 */
export const CANVAS_SAME_POINT_MESSAGE =
  '2 つの点が同じ位置です。離れた 2 点を指してください。';

/** 同じく、実寸に 0 以下や数でないものが入ったときの断り。 */
export const CANVAS_INVALID_LENGTH_MESSAGE = '実寸は 0 より大きい長さを入れてください。';

/**
 * PNG の署名(8 バイト、PNG の仕様)。`89 50 4E 47 0D 0A 1A 0A`。
 * 先頭の `89` と `50 4E 47`(= "PNG")のあとに CRLF・EOF・LF が続き、
 * テキストとして転送されて壊れた場合に気づけるようになっている。
 */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * JPEG の先頭(3 バイト)。`FF D8 FF`。`FF D8` が SOI(画像の始まり)で、
 * 続く `FF` は次のマーカーの始まりである(4 バイト目は JFIF / Exif で違うので見ない)。
 */
const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff];

/** バイト列が指定の並びで始まるか。 */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) {
      return false;
    }
  }
  return true;
}

/**
 * バイト列の先頭から画像の形式を見分ける(§0.a-0.45)。PNG でも JPEG でもなければ `null`。
 *
 * **拡張子ではなくバイト列で見る。** 名前はいくらでも変えられるので、`.png` という名前の
 * GIF を受け取ってしまうと、貼った下絵が画面に出ないだけの分かりにくい不具合になる
 * (`packages/io` の `isTemplateKind` が拡張子ではなく封筒の種別を見るのと同じ考え方)。
 */
export function detectImageFormat(bytes: Uint8Array): CanvasImageFormat | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return 'png';
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return 'jpeg';
  }
  return null;
}

/** 下絵の画像を受け付けられない理由(§2.8 の表)。 */
export type CanvasImageRefusal = 'unsupportedFormat' | 'tooLarge';

/** 下絵の画像を確かめた結果。断るときは理由と、そのまま見せられる日本語を返す。 */
export type CheckCanvasImageResult =
  | { readonly ok: true; readonly format: CanvasImageFormat }
  | {
      readonly ok: false;
      readonly reason: CanvasImageRefusal;
      readonly message: string;
    };

/**
 * 読み込もうとしている画像を受け付けられるか確かめる(§0.a-0.45)。
 *
 * **形式を先に見る。** 8MB を超える GIF は「対応していない画像です。」と伝えたほうが、
 * 利用者が次に何をすればよいか(PNG か JPEG に変換する)が分かるためである
 * (先に大きさを断ると、小さくしてから改めて形式で断られる)。
 */
export function checkCanvasImage(bytes: Uint8Array): CheckCanvasImageResult {
  const format = detectImageFormat(bytes);
  if (format === null) {
    return {
      ok: false,
      reason: 'unsupportedFormat',
      message: CANVAS_UNSUPPORTED_FORMAT_MESSAGE,
    };
  }
  if (bytes.length > MAX_CANVAS_IMAGE_BYTES) {
    return { ok: false, reason: 'tooLarge', message: CANVAS_TOO_LARGE_MESSAGE };
  }
  return { ok: true, format };
}

/** 画像の上の 1 点(画素。左上が原点で、`u` が右、`v` が下)。 */
export type CanvasPixelPoint = readonly [number, number];

/** 寸法合わせができなかった理由(§2.14 の表)。 */
export type CanvasScaleRefusal = 'samePoint' | 'invalidLength';

/** 寸法合わせの結果。 */
export type ScaleFromTwoPointsResult =
  | {
      readonly ok: true;
      /** 縮尺(mm / 画素)。 */
      readonly scale: number;
      /** 2 点の画素の距離。検算と案内のために返す(§2.14 の導出の表)。 */
      readonly pixelDistance: number;
    }
  | {
      readonly ok: false;
      readonly reason: CanvasScaleRefusal;
      readonly message: string;
    };

/**
 * 画像の上で指した 2 点と、その 2 点の実寸(mm)から縮尺を決める(FR-332、§0.a-0.46)。
 *
 * ```
 * 画素の距離 d = √((u₂−u₁)² + (v₂−v₁)²)
 * 縮尺 s = L / d   [mm / 画素]
 * ```
 *
 * 例(§2.14): (100,100)〜(500,100) の 400 画素を 200mm と指定すると `s = 0.5`。
 *
 * **2 点が同じ位置なら断る**(0 除算の防止、NFR-UX-5)。**実寸が 0 以下・有限でない
 * ときも断る**(縮尺が 0 や負や NaN になると、画像が消える・裏返る・寸法が
 * 読めなくなる。式が壊れているときの評価値 NaN もここで止まる)。
 */
export function scaleFromTwoPoints(
  p1: CanvasPixelPoint,
  p2: CanvasPixelPoint,
  realLengthMm: number,
): ScaleFromTwoPointsResult {
  const du = p2[0] - p1[0];
  const dv = p2[1] - p1[1];
  const pixelDistance = Math.hypot(du, dv);
  if (!Number.isFinite(pixelDistance) || pixelDistance === 0) {
    return { ok: false, reason: 'samePoint', message: CANVAS_SAME_POINT_MESSAGE };
  }
  if (!Number.isFinite(realLengthMm) || realLengthMm <= 0) {
    return { ok: false, reason: 'invalidLength', message: CANVAS_INVALID_LENGTH_MESSAGE };
  }
  return { ok: true, scale: realLengthMm / pixelDistance, pixelDistance };
}

/** 画像の作図面での大きさ(mm)。 */
export interface CanvasSizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

/**
 * 縮尺と画素の大きさから、作図面に貼る大きさ(mm)を出す(§2.14)。
 *
 * ```
 * 幅(mm) = s × 画素の幅   高さ(mm) = s × 画素の高さ
 * ```
 *
 * 例(§2.14): `s = 0.5` の 800×600 画素の画像は 400mm × 300mm になる。
 * **`SketchCanvas` は幅と高さ(mm)だけを持ち、縮尺は保存しない**(縮尺は幅 ÷ 画素の幅で
 * いつでも出せる。導出できるものは保存しない、`rules/04`)。
 */
export function canvasSizeFromScale(
  scale: number,
  pixelWidth: number,
  pixelHeight: number,
): CanvasSizeMm {
  return { widthMm: scale * pixelWidth, heightMm: scale * pixelHeight };
}

/** 下絵の id の接頭辞(`nextSelectionSetId` / `nextAppearanceId` と同じ採番規則)。 */
const CANVAS_ID_PREFIX = 'canvas-';

/** 次の下絵の id を作る(`canvas-<n>`)。既存の同じ形の id の最大連番 + 1 を採る。 */
export function nextCanvasId(canvases: readonly SketchCanvas[]): string {
  let max = 0;
  for (const canvas of canvases) {
    if (!canvas.id.startsWith(CANVAS_ID_PREFIX)) {
      continue;
    }
    const serial = Number(canvas.id.slice(CANVAS_ID_PREFIX.length));
    if (Number.isInteger(serial) && serial > max) {
      max = serial;
    }
  }
  return `${CANVAS_ID_PREFIX}${String(max + 1)}`;
}

/** 下絵を 1 つ消す。見つからなければ元の配列を同一参照のまま返す。 */
export function removeCanvas(
  canvases: readonly SketchCanvas[],
  id: string,
): readonly SketchCanvas[] {
  if (!canvases.some((canvas) => canvas.id === id)) {
    return canvases;
  }
  return canvases.filter((canvas) => canvas.id !== id);
}

/**
 * 下絵の入切(FR-332)。**形に影響しない**ので、切り替えても再計算は走らない
 * (`part/documentChange.ts` の `affectsShape` が偽を返す。§2.14 の表)。
 * 値が変わらなければ元の配列を同一参照のまま返す。
 */
export function setCanvasVisible(
  canvases: readonly SketchCanvas[],
  id: string,
  visible: boolean,
): readonly SketchCanvas[] {
  const existing = canvases.find((canvas) => canvas.id === id);
  if (existing === undefined || existing.visible === visible) {
    return canvases;
  }
  return canvases.map((canvas) => (canvas.id === id ? { ...canvas, visible } : canvas));
}
