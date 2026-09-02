/**
 * `@pointercad/ui` の公開口。
 *
 * 使う側は `apps/web` と `apps/desktop` の入口だけで、必要なのは画面そのもの
 * (`PointerCadApp`)と、起動に失敗したときの文言を引く `t` の 2 つ(要件§1.5、NFR-MA-5)。
 * パッケージの中どうしは実ファイルを直に読み合うので、ここへ並べる必要はない。
 * 誰も使わない輸出を並べておくと、消してよいものが分からなくなるため置かない。
 */
export { t } from './i18n/t.js';
export { PointerCadApp } from './app/PointerCadApp.js';
