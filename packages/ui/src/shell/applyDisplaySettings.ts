/**
 * 表示設定(テーマ・拡大率)をルート要素へ
 * 反映する。
 *
 * `appShell.css` は `[data-theme="…"]` セレクタで `:root` の `--pcad-*` トークンを
 * 丸ごと上書きする設計。ここはルート要素(`document.documentElement`)へ
 * `data-theme` 属性と `--pcad-scale` カスタムプロパティを書くだけで、CSS 側の
 * トークン定義そのものには触れない(`appShell.css` を正本のまま保つ)。
 *
 * three.js 側(ビューポートの背景・グリッド・スケッチの既定色)は CSS 変数を直接読めないため
 * `getComputedStyle` で読み直す別の配線が要る(この関数の範囲外)。
 */

import type { DisplaySettings } from '../settings/settings.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * `applyDisplaySettings` が触る、ルート要素として最小限必要な形。
 * `document.documentElement` の一部だけを使うので、検査では DOM 全体を用意せずに
 * この形を満たす偽物を渡せる。
 */
interface ThemeRootElement {
  dataset: { theme?: string; uiScale?: string };
  readonly style: { setProperty: (property: string, value: string) => void };
}

/**
 * 表示設定をルート要素へ書く。`data-theme` は `appShell.css` の `[data-theme="…"]` を
 * 選び直し、`--pcad-scale` は 0.9〜1.5 の倍率(`uiScale` は 90〜150 の百分率)として渡す。
 *
 * `data-ui-scale` は `uiScale` をそのまま文字列にした属性(例: `data-ui-scale="150"`)。
 * `appShell.css` のツールバーの 2 段の整形が、窓幅の媒体条件だけでなくこの属性でも
 * 効くようにするため(拡大率は媒体条件からは読めない)。
 */
export function applyDisplaySettings(settings: DisplaySettings, root: ThemeRootElement): void {
  root.dataset.theme = settings.theme;
  root.dataset.uiScale = String(settings.uiScale);
  root.style.setProperty('--pcad-scale', String(settings.uiScale / 100));
}

/**
 * ストアの `displaySettings` の変化を見張り、変わるたびにルート要素へ反映する
 * (`PointerCadApp.tsx` が起動時に 1 回呼ぶ)。**戻り値を呼ぶと見張りをやめる。**
 *
 * 呼んだ直後にも 1 回反映するので、初回描画から正しいテーマ・拡大率になる
 * (「切り替えは再起動なしに即時反映」はここと `setDisplaySettings` の両方で成立する)。
 */
export function attachDisplaySettings(root: ThemeRootElement): () => void {
  applyDisplaySettings(useAppStore.getState().displaySettings, root);
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.displaySettings === previous.displaySettings) {
      return;
    }
    applyDisplaySettings(next.displaySettings, root);
  });
  return unsubscribe;
}
