/**
 * 「見た目」の区画の配線のうち、下絵(FR-332、P6 タスク39)の読み込み。
 *
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import { checkCanvasImage, DEFAULT_WORK_PLANE_ID, isFreeWorkPlaneId } from '@pointercad/model';
import {
  decodeCanvasImage,
  newSketchCanvas,
  pickCanvasImage,
  type PickedCanvasImage,
} from '../../file/canvasFile.js';
import { t } from '../../i18n/t.js';
import { useAppStore } from '../../store/useAppStore.js';

/**
 * 下絵を 1 枚読み込んで作図面に貼る(FR-332、P6 タスク39、計画書 §0.a-0.45)。
 *
 * 画像を選ぶ → 受け付けられるか確かめる(PNG / JPEG・8MB。判定と断りの文言は
 * `@pointercad/model` の `sketch/canvas.ts` が正本)→ 画素の大きさを測る → いまの作図面へ
 * 幅 100mm で貼る → **そのまま 2 点の寸法合わせへ誘う**(§2.14。貼ったままの大きさは
 * 出発点にすぎないので、続けて実寸を合わせられるようにする)。
 *
 * ここで復号した画像は**画素の大きさを測るためだけ**に使い、すぐ閉じる。画面に貼る
 * テクスチャ用の画像はビューポート(`ViewportCanvas.tsx`)が自分で復号して持ち主になる
 * (1 枚の画像を 2 か所が閉じる形にしない)。
 *
 * **断りは下絵の欄に出す**(ステータスバーの「図形を作れませんでした:」等の言い回しに
 * 混ぜない)。取り消し(窓を閉じた)は断りではないので何も出さない。
 */
export async function addCanvasFromFile(): Promise<void> {
  const store = useAppStore.getState();
  let picked: PickedCanvasImage | null;
  try {
    picked = await pickCanvasImage();
  } catch {
    store.setCanvasMessage(t('file.openFailed'));
    return;
  }
  if (picked === null) {
    return;
  }
  const checked = checkCanvasImage(picked.bytes);
  if (!checked.ok) {
    store.setCanvasMessage(checked.message);
    return;
  }
  let image;
  try {
    image = await decodeCanvasImage(picked.bytes, checked.format);
  } catch {
    store.setCanvasMessage(t('file.openFailed'));
    return;
  }
  // 待っている間に文書が変わっているかもしれないので、いまの状態を読み直してから足す。
  const latest = useAppStore.getState();
  // 3D スケッチ(作図面なし、FR-330)のときは基準の XY へ貼る(貼る面が要るため)。
  const plane = isFreeWorkPlaneId(latest.workPlaneId) ? DEFAULT_WORK_PLANE_ID : latest.workPlaneId;
  const canvas = newSketchCanvas(latest.document.canvases, plane, picked.fileName, image);
  latest.setCanvasPixelSize(canvas.imageId, { width: image.width, height: image.height });
  image.close?.();
  latest.addCanvas(canvas, picked.bytes);
  latest.startCanvasScale(canvas.id);
}
