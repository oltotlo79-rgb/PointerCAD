/**
 * ツールバーの区画に共通の小物(ボタン 1 つぶんの形・区切り文字・押した場所の既定)。
 *
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import { type MessageKey, t } from '../../i18n/t.js';
import { useAppStore } from '../../store/useAppStore.js';
import type { IconProps } from '../icons.js';

/** 図柄のボタン 1 つぶんの定義。区画ごとの表はすべてこの形に揃える。 */
export interface ButtonEntry {
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly Icon: (props: IconProps) => React.JSX.Element;
}

/** 行を分ける改行。ツールチップに 2 行以上を出すときに使う。 */
export const TOOLTIP_LINE_BREAK = '\n';

/** ビューポートの大きさがまだ分からないときに使う基準位置(画素)。 */
const FALLBACK_ANCHOR_PIXELS = 160;

/** 名前と理由をつなぐ区切り。文字そのものは言葉に依らないのでここに置く。 */
export const LABEL_SEPARATOR = ': ';

/** 畳んだ一覧の名前をつなぐ区切り。 */
export const NAME_SEPARATOR = ' / ';

/**
 * ポップアップを出す基準の画面座標(§2.9「表示位置」)。
 *
 * 道具を選んだ直後はまだどこもクリックしていないので、ビューポートのほぼ中央を基準にする。
 * 大きさは `AppShell` が実寸を入れたストアから読む(DOM を直接探しに行かない、
 * rules/04-設計の規律.md)。はみ出しの折り返しはポップアップ側(`clampAnchor`)が行う。
 */
export function viewportCenterAnchor(): readonly [number, number] {
  const [width, height] = useAppStore.getState().viewportSize;
  if (width <= 0 || height <= 0) {
    return [FALLBACK_ANCHOR_PIXELS, FALLBACK_ANCHOR_PIXELS];
  }
  return [Math.round(width / 2), Math.round(height / 2)];
}

/** 押せないときのツールチップ。「名前: 理由」で、なぜ押せないのかを読めるようにする。 */
export function unavailableTooltip(labelKey: MessageKey, reasonKey: MessageKey | null): string {
  return reasonKey === null ? t(labelKey) : `${t(labelKey)}${LABEL_SEPARATOR}${t(reasonKey)}`;
}
