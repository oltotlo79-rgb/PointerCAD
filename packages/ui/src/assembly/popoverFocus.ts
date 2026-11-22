/**
 * 値・範囲の文字の欄があればそこへ焦点を置いて全選択し、無ければ指定の戻り先（既定は窓そのもの）へ置く。
 * 種類の選ぶ欄(select)も見た目をそろえるため同じ class(pcad-field__input)を持つので、探すのは input に限る
 * (select には select() が無く、拾うと例外で窓が描けない。UI の点検の指摘 9)。
 */
export function focusFirstTextField(panel: HTMLElement | null, fallback: HTMLElement | null = panel): void {
  const field = panel?.querySelector<HTMLInputElement>('input.pcad-field__input');
  if (field != null) { field.focus(); field.select(); }
  else fallback?.focus();
}
