/**
 * 下絵の画像を選ぶ・描ける形へ復号する口(計画書 docs/plans/P6-入出力.md §0.a-0.45、
 * §0.a-0.46、§2.14、タスク39)。
 *
 * 対応要件: FR-332(読み込んだ画像を作図面に置いて、2 点で寸法を合わせ、なぞる)、
 * NFR-SE-1(パスを持ち回らない)、要件§1.5(Web 版とデスクトップ版に機能差を作らない)。
 *
 * **`FileGateway`(`fileGateway.ts`)を通さない理由**(タスク39 の判断):
 * 種類つきの出し入れが受け付ける `FileKind`(正本は `@pointercad/model` の `exchange/types.ts`)
 * には画像が無い。表へ PNG / JPEG を足すと、種類の表は**書き出しの窓**(`saveFileAs`)とも
 * 共有なので、書き出せない形式が書き出しの一覧に並んでしまう。下絵は「読むだけ・上書き先を
 * 覚えない・書き出さない」の 1 方向しか使わないので、ここに**読む口だけ**を置く。
 * (種類の表へ画像を足すかどうかは `exchange/types.ts` を持つ担当の判断。足りたら
 * この口は `openFileThrough` の呼び出し 1 行へ縮む。)
 *
 * **受け付けの判定はここに書かない。** PNG / JPEG の見分け(マジックバイト)と 8MB の上限、
 * および断りの日本語は `@pointercad/model` の `sketch/canvas.ts`(タスク38)が持つ
 * (上限の数を知っているのがあの層だけなので、文言を写すと数字が 2 か所で食い違う)。
 * ここは選んだバイト列をそのまま返し、確かめるのは呼び出し側(ストア)が
 * `checkCanvasImage` で行う。
 *
 * **DOM に触れるのはこのファイルの下半分だけ。** `document` と `createImageBitmap` は
 * `fileGateway.ts` と同じ流儀で `in` と `typeof` を 1 段ずつ辿って絞り込み、`as` による
 * 強制変換は使わない(rules/02-禁止事項.md)。調べる相手を引数で受けるので、検査からは
 * 偽の相手を渡せる(本物の `globalThis` へ欄を差し込むと他の検査へ漏れる)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  nextCanvasId,
  type CanvasImageFormat,
  type SketchCanvas,
  type WorkPlaneId,
} from '@pointercad/model';

import { t } from '../i18n/t.js';

/** 選んだ画像 1 枚ぶん。パスは含まない(ブラウザは渡してくれない。NFR-SE-1)。 */
export interface PickedCanvasImage {
  /** 拡張子を含むファイル名。下絵の既定の名前(FR-501)に使う。 */
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/**
 * ファイル選択の窓に出す種類。**PNG と JPEG だけ**(§0.a-0.45。ブラウザが必ず読める 2 つ)。
 * 拡張子ではなく MIME 型で書くのは、`.PNG` のような大文字や、拡張子の無いファイルも
 * 選べるようにするため(中身の判定は `detectImageFormat` がバイト列で行う)。
 */
export const CANVAS_IMAGE_ACCEPT = 'image/png,image/jpeg';

/** 形式ごとの MIME 型。復号器へ「何のバイト列か」を伝えるためだけに使う。 */
const CANVAS_IMAGE_MIME_TYPES: Readonly<Record<CanvasImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/** その形式の MIME 型(`Blob` に渡す)。 */
export function canvasImageMimeType(format: CanvasImageFormat): string {
  return CANVAS_IMAGE_MIME_TYPES[format];
}

/**
 * 復号した画像。**three.js のテクスチャの素材**になり、画素の幅・高さは 2 点の寸法合わせ
 * (§2.14 の `幅(mm) = 縮尺 × 画素の幅`)が使う。
 *
 * ブラウザでは `createImageBitmap` が返す `ImageBitmap` がそのまま当てはまる。
 * 欄を絞った形にしてあるのは、three.js に触れない検査(Node)から偽の画像を渡せるようにする
 * ため(`{ width: 800, height: 600 }` で足りる)。
 *
 * **`close()` は持ち主が呼ぶ。** `ImageBitmap` は使い終わったら閉じて記憶を返す決まりだが、
 * 閉じる責任は復号した画像を覚えている側(画面の控え)にあり、描画層(`canvasLayer.ts`)は
 * 自分が作ったテクスチャ・材質・形だけを捨てる(持ち主を 2 か所に作らない)。
 */
export interface DecodedCanvasImage {
  /** 画素の幅。 */
  readonly width: number;
  /** 画素の高さ。 */
  readonly height: number;
  /** 記憶を返す(`ImageBitmap` は持つ。検査の偽の画像は持たない)。 */
  close?(): void;
}

// ---------------------------------------------------------------------------
// 相手を 1 段ずつ絞る(`as` を使わない。`fileGateway.ts` と同じ流儀)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** ファイル選択に使う `<input type="file">`。書き込むだけの欄は確かめない。 */
interface FilePickerInput {
  type: string;
  accept: string;
  hidden: boolean;
  /** 選ばれたファイル。選ばれなければ空・null・undefined のいずれもあり得る。 */
  readonly files?: { readonly [index: number]: unknown } | null;
  addEventListener(type: string, listener: () => void): void;
  click(): void;
  remove(): void;
}

interface DomDocument {
  createElement(tagName: string): unknown;
  readonly body: { append(node: unknown): void };
}

interface DocumentScope {
  readonly document: DomDocument;
}

/** 読み出したファイルの中身(名前つき)。 */
interface NamedReadableFile {
  readonly name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isDomDocument(value: unknown): value is DomDocument {
  return (
    isObject(value) &&
    'createElement' in value &&
    typeof value.createElement === 'function' &&
    'body' in value &&
    isObject(value.body) &&
    'append' in value.body &&
    typeof value.body.append === 'function'
  );
}

function hasDocument(scope: object): scope is DocumentScope {
  return 'document' in scope && isDomDocument(scope.document);
}

function isFilePickerInput(value: unknown): value is FilePickerInput {
  return (
    isObject(value) &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'click' in value &&
    typeof value.click === 'function' &&
    'remove' in value &&
    typeof value.remove === 'function'
  );
}

function isNamedReadableFile(value: unknown): value is NamedReadableFile {
  return (
    isObject(value) &&
    'name' in value &&
    typeof value.name === 'string' &&
    'arrayBuffer' in value &&
    typeof value.arrayBuffer === 'function'
  );
}

/** 画像の復号器を持つ相手(ブラウザ)。 */
interface ImageDecoderScope {
  createImageBitmap(blob: Blob, options?: { readonly imageOrientation?: 'flipY' }): Promise<unknown>;
}

function hasImageDecoder(scope: object): scope is ImageDecoderScope {
  return 'createImageBitmap' in scope && typeof scope.createImageBitmap === 'function';
}

function isDecodedCanvasImage(value: unknown): value is DecodedCanvasImage {
  return (
    isObject(value) &&
    'width' in value &&
    typeof value.width === 'number' &&
    'height' in value &&
    typeof value.height === 'number'
  );
}

// ---------------------------------------------------------------------------
// 選ぶ・復号する
// ---------------------------------------------------------------------------

/**
 * 下絵にする画像を選ぶ(FR-332)。取り消されたら null。
 *
 * **上書き先は覚えない**(そもそも書き出さない)ので、`.pcad` の保存先(`hasSaveTarget`)には
 * 一切触らない。取り消しは `cancel` の知らせで拾い、拾えない古いブラウザでは選ぶまで待ち続ける
 * (その間も画面の操作は止まらない。`fileGateway.ts` の `pickFileWithInput` と同じ振る舞い)。
 */
export function pickCanvasImage(scope: object = globalThis): Promise<PickedCanvasImage | null> {
  return new Promise<PickedCanvasImage | null>((resolve, reject) => {
    if (!hasDocument(scope)) {
      reject(new Error(t('file.openFailed')));
      return;
    }
    const created = scope.document.createElement('input');
    if (!isFilePickerInput(created)) {
      reject(new Error(t('file.openFailed')));
      return;
    }
    const input = created;
    input.type = 'file';
    input.accept = CANVAS_IMAGE_ACCEPT;
    input.hidden = true;

    const finish = (picked: PickedCanvasImage | null): void => {
      input.remove();
      resolve(picked);
    };

    input.addEventListener('cancel', () => {
      finish(null);
    });
    input.addEventListener('change', () => {
      const file: unknown = input.files?.[0];
      if (!isNamedReadableFile(file)) {
        finish(null);
        return;
      }
      file.arrayBuffer().then(
        (buffer) => {
          finish({ fileName: file.name, bytes: new Uint8Array(buffer) });
        },
        (error: unknown) => {
          input.remove();
          reject(error instanceof Error ? error : new Error(t('file.openFailed')));
        },
      );
    });

    scope.document.body.append(input);
    input.click();
  });
}

/**
 * 画像のバイト列を描ける形へ復号する(§0.a-0.46「作図面に貼る」)。
 *
 * **`imageOrientation: 'flipY'` を必ず頼む。** three.js の `Texture.flipY`(既定 true)は
 * `ImageBitmap` には効かない決まりなので、ここで上下を返しておかないと下絵が逆さまに貼られる。
 * こうしておくと、面の uv は普通の画像と同じ向き(v = 1 が画像の上端。`canvasLayer.ts` の
 * `CANVAS_CORNER_UVS`)で書ける。
 *
 * 復号できない(壊れた画像・PNG / JPEG でないものを PNG と名乗らせた等)ときは断る。
 * 形式そのものの見分けは呼び出し側が `checkCanvasImage` で先に済ませておく。
 */
export async function decodeCanvasImage(
  bytes: Uint8Array,
  format: CanvasImageFormat,
  scope: object = globalThis,
): Promise<DecodedCanvasImage> {
  if (!hasImageDecoder(scope)) {
    // 画像を復号できない相手(ブラウザではない)。読めなかったこととして断る。
    throw new Error(t('file.openFailed'));
  }
  /*
    `Blob` は「共有できる記憶を指していないバイト列」しか受け取らない。渡された並びが
    どちらの記憶を指しているかは呼び出し側次第なので、ここで自前の記憶へ写してから渡す
    (`fileGateway.ts` の `downloadBytes` と同じ事情)。
  */
  const plain = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  plain.set(bytes);
  const blob = new Blob([plain], { type: canvasImageMimeType(format) });
  const decoded: unknown = await scope.createImageBitmap(blob, { imageOrientation: 'flipY' });
  if (!isDecodedCanvasImage(decoded)) {
    throw new Error(t('file.openFailed'));
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// 読み込んだ画像を下絵 1 枚にする(純関数)
// ---------------------------------------------------------------------------

/**
 * 貼ったばかりの下絵の幅(mm)。**縦横比は画像のまま**にして高さを決める。
 *
 * 画素をそのまま mm にすると、写真(4000 画素)が 4m の下絵になって画面から溢れる。
 * 100mm は起動時の方眼(1 目盛 10mm)にちょうど収まる大きさで、**この後に 2 点の
 * 寸法合わせ(§2.14)で本当の寸法へ合わせる**ことが前提の出発点である。
 */
export const DEFAULT_CANVAS_WIDTH_MM = 100;

/**
 * 貼ったばかりの下絵の不透明度(0〜1)。**なぞるための薄い紙**なので、線を引いたときに
 * 下絵と線が見分けられる濃さにする(§2.14 の表の 0.5 と同じ値)。
 */
export const DEFAULT_CANVAS_OPACITY = 0.5;

/**
 * 読み込んだ画像から下絵 1 枚(文書の `SketchCanvas`)を作る(FR-332、§0.a-0.45)。
 *
 * - id は既存の下絵から続けて採番する(`nextCanvasId`)。**画像の鍵(`imageId`)も同じ値**に
 *   して、`.pcad` の ZIP のエントリ `canvases/<imageId>.png` と 1 対 1 にする。
 * - 名前はファイル名をそのまま使う(FR-501。利用者が付け直せる)。
 * - 中心は作図面の原点、向きは 0、大きさは幅 100mm と画像の縦横比(上の定数)。
 * - 画素の大きさは**保存しない**(復号した画像がいつでも答える。`rules/04`)。
 */
export function newSketchCanvas(
  existing: readonly SketchCanvas[],
  plane: WorkPlaneId,
  fileName: string,
  image: DecodedCanvasImage,
): SketchCanvas {
  const id = nextCanvasId(existing);
  // 画素の幅が 0(壊れた画像)でも高さを 0 にしない。0 だと面が消えて掴めなくなる。
  const aspect = image.width > 0 ? image.height / image.width : 1;
  return {
    id,
    name: fileName,
    plane,
    imageId: id,
    width: expressionValueFromNumber(DEFAULT_CANVAS_WIDTH_MM),
    height: expressionValueFromNumber(DEFAULT_CANVAS_WIDTH_MM * aspect),
    origin: {
      mode: 'absolute',
      x: expressionValueFromNumber(0),
      y: expressionValueFromNumber(0),
      z: expressionValueFromNumber(0),
    },
    rotation: expressionValueFromNumber(0),
    opacity: expressionValueFromNumber(DEFAULT_CANVAS_OPACITY),
    visible: true,
  };
}
