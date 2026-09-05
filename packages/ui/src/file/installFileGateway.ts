/**
 * ファイルの読み書きの口を、外(`apps/`)から差し込むための薄い口。
 *
 * 対応要件: FR-806、要件§1.5(Web 版とデスクトップ版に機能差を作らない)。
 *
 * デスクトップ版は OS のダイアログでファイルを開き書くので、`apps/desktop` が自前の
 * 実装をここから差し込む。UI から `apps/` を import できない(依存方向、rules/04)ので、
 * 向きを逆にして「差し込まれる側」をこちらに置く。
 *
 * ストアそのものを `index.ts` から輸出しないのは、外から触れる範囲を広げないため。
 * 外に要るのは**この 1 つの操作だけ**で、状態の読み書きは `@pointercad/ui` の中で完結する。
 *
 * ストアを読むのはこのファイルだけにしてあるので、`fileGateway.ts`(ストアが読む側)と
 * 参照が輪にならない。
 */

import { useAppStore } from '../store/useAppStore.js';

import type { FileGateway } from './fileGateway.js';

/**
 * ファイルの読み書きの口を差し替える。画面(React)を起動する前に呼ぶ。
 * 呼ばなければ、ブラウザ用の口(`createBrowserFileGateway`)がそのまま使われる。
 *
 * 種類つきの出し入れ(`openFile` / `saveFileAs`。P6 計画書 タスク4)は**省いてよい欄**なので、
 * 部品の読み書き 3 本だけを持つ口も今までどおり差し込める。省かれた口へ頼んだときは
 * `openFileThrough` / `saveFileAsThrough` がブラウザ用の実装で答える(要件§1.5 の保険)。
 */
export function setFileGateway(gateway: FileGateway): void {
  useAppStore.getState().setFileGateway(gateway);
}
