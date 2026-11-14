/*
 * マウスのホバーで出す案内の箱の時間の決まり(FR-904、NFR-UX-7)。図柄だけのボタンにマウスを 0.3 秒置くと、
 * キーボードの焦点の時と同じ箱(KeyboardControlHint)を出す。OS のツールチップ(title)は残し、その代わりに
 * するのではなく足す。DOM に触れないので、時間の決まりを単体で確かめられる。
 */

/** マウスを置いてから箱を出すまでの時間(ミリ秒)。OS のツールチップより早く、通り過ぎただけでは出さない長さ。 */
export const HOVER_HINT_DELAY_MS = 300;

interface HoverHintTimerOptions<Control> {
  readonly delayMs: number;
  readonly show: (control: Control) => void;
  readonly hide: () => void;
}

/**
 * ホバーの箱の時計。enter で数え始め、時間がたったら show。leave・別の control への enter・press・cancel で
 * 止める。press(押した)の後は、その control から一度離れるまで出し直さない(押した直後に箱が戻らない)。
 */
export function createHoverHintTimer<Control>(options: HoverHintTimerOptions<Control>) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let current: Control | null = null;
  let shown = false;
  let pressedOn: Control | null = null;
  const stop = (): void => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    if (shown) { shown = false; options.hide(); }
  };
  return {
    enter(control: Control): void {
      if (control === current && (pending !== null || shown)) return;
      stop();
      current = control;
      if (pressedOn === control) return;
      pending = setTimeout(() => { pending = null; shown = true; options.show(control); }, options.delayMs);
    },
    leave(control: Control): void {
      if (pressedOn === control) pressedOn = null;
      if (control !== current) return;
      stop();
      current = null;
    },
    press(): void {
      pressedOn = current;
      stop();
    },
    cancel(): void {
      stop();
      current = null;
    },
  };
}
