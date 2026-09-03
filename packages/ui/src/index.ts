/**
 * `@pointercad/ui` の公開口。
 *
 * 使う側は `apps/web` と `apps/desktop` の入口だけで、必要なのは画面そのもの
 * (`PointerCadApp`)と、起動に失敗したときの文言を引く `t`(要件§1.5、NFR-MA-5)、
 * それにデスクトップ版がファイルの読み書きを OS のダイアログへ差し替えるための
 * `setFileGateway` と、その引数の形(`FileGateway` / `PickedFile`)だけ。
 * パッケージの中どうしは実ファイルを直に読み合うので、ここへ並べる必要はない。
 * 誰も使わない輸出を並べておくと、消してよいものが分からなくなるため置かない。
 *
 * ストア(`useAppStore`)そのものは輸出しない。外へ開くのは差し替えの 1 操作だけにし、
 * 状態の読み書きは `@pointercad/ui` の中で完結させる。
 */
export { t } from './i18n/t.js';
export { PointerCadApp } from './app/PointerCadApp.js';
export { setFileGateway } from './file/installFileGateway.js';
export type { FileGateway, PickedFile } from './file/fileGateway.js';
