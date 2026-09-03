/**
 * `.pcad` に入れるサムネイルの作成(計画書 docs/plans/P2-ソリッド基礎.md タスク20 手順5、§0.a-0.18)。
 *
 * 対応要件: FR-801(保存する中身)、NFR-PF-1(常時の描画性能を落とさない)。
 *
 * ビューポートの canvas から絵を読むのは **描いた直後の同じ同期処理の中** でなければ
 * ならない(WebGL の描画バッファは画面へ出した時点で捨てられる。`preserveDrawingBuffer`
 * を常時有効にすると毎フレームの費用が上がるので使わない)。そのため読み取りは
 * `createViewportScene.ts` の `captureThumbnail` が描画の直後に呼ぶ。
 *
 * ここには「大きさの決め方」と「data URL からバイト列へ」の 2 つを純関数として置き、
 * canvas を触る部分は 1 つの関数(`captureThumbnailPng`)にまとめて、
 * 失敗しても例外を投げず null を返す(サムネイルが無くても保存はできる、§0.a-0.18)。
 */

/** サムネイルの一辺の上限(§0.a-0.18)。 */
export const THUMBNAIL_SIZE = 256;

/**
 * 余白の色。画面の背景(packages/ui/src/shell/appShell.css の
 * --pcad-viewport-top / --pcad-viewport-bottom)と同じ縦のグラデーションで塗り、
 * 画面で見えている絵と同じ見た目にする。ビューポートの canvas は背景が透明で、
 * 背景そのものは CSS が描いているため、ここで塗り直す必要がある。
 */
export const THUMBNAIL_BACKGROUND_TOP = '#2a2e37';
export const THUMBNAIL_BACKGROUND_BOTTOM = '#1b1e24';

/** PNG の data URL の前置き。これ以外の形は受け取らない。 */
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/** 縮小した絵を置く場所(サムネイルの左上を原点とした画素)。 */
export interface ThumbnailRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 元の絵を一辺 `size` の正方形へ収める場所を決める。縦横比は保ち、余った側は余白にする。
 *
 * **拡大はしない**(元が小さいときはそのままの大きさで中央に置く)。引き伸ばした絵は
 * 元より粗く見えるだけで情報が増えないため。大きさが決められないときは null。
 */
export function thumbnailFitRect(
  sourceWidth: number,
  sourceHeight: number,
  size: number = THUMBNAIL_SIZE,
): ThumbnailRect | null {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    !Number.isFinite(size) ||
    size <= 0
  ) {
    return null;
  }
  const scale = Math.min(size / sourceWidth, size / sourceHeight, 1);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x: Math.round((size - width) / 2),
    y: Math.round((size - height) / 2),
    width,
    height,
  };
}

/**
 * PNG の data URL をバイト列へ直す。PNG 以外・壊れている場合は null。
 *
 * `atob` は base64 の 1 文字ずつを文字コード 0〜255 の文字へ直すので、
 * 文字コードをそのままバイトとして写せばよい。
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    return null;
  }
  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let position = 0; position < binary.length; position += 1) {
    bytes[position] = binary.charCodeAt(position) & 0xff;
  }
  return bytes;
}

/**
 * 描き終わった canvas を一辺 `size` の PNG のバイト列にする(§0.a-0.18)。
 *
 * **呼ぶのは絵を描いた直後の同じ同期処理の中**。`Image` の読み込みを挟むと非同期になり、
 * その間に描画バッファが捨てられてしまうため、canvas から canvas へ直接写す。
 * 用意ができていない・2D の下地が作れない・書き出しに失敗したときは null を返す。
 */
export function captureThumbnailPng(
  source: HTMLCanvasElement,
  size: number = THUMBNAIL_SIZE,
): Uint8Array | null {
  const rect = thumbnailFitRect(source.width, source.height, size);
  if (rect === null) {
    return null;
  }
  try {
    const target = source.ownerDocument.createElement('canvas');
    target.width = size;
    target.height = size;
    const context = target.getContext('2d');
    if (context === null) {
      return null;
    }
    const background = context.createLinearGradient(0, 0, 0, size);
    background.addColorStop(0, THUMBNAIL_BACKGROUND_TOP);
    background.addColorStop(1, THUMBNAIL_BACKGROUND_BOTTOM);
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    context.drawImage(source, rect.x, rect.y, rect.width, rect.height);
    return dataUrlToBytes(target.toDataURL('image/png'));
  } catch {
    return null;
  }
}
