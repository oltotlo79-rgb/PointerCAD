/**
 * その場の窓を開いた時の最初の焦点。値・範囲の文字の欄があればそこへ置いて全選択し、無ければ窓そのものへ置く。
 * 種類の選ぶ欄(select)も見た目をそろえるため同じ class(pcad-field__input)を持つので、探すのは input に限る
 * (select には select() が無く、拾うと例外で窓が描けない。UI の点検の指摘 9)。
 */
export function focusFirstTextField(panel: HTMLElement | null): void {
  const field = panel?.querySelector<HTMLInputElement>('input.pcad-field__input');
  if (field != null) { field.focus(); field.select(); }
  else panel?.focus();
}
