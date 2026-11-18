import { commandDefinition, type CommandId } from './commandDefinitions.js';

/*
 * マウスのボタンへの命令の割当(設計 2-4・B-08e)。戻る・進むボタンと、中ボタンのダブルクリックに、キーと同じ命令を
 * 割り当てる。既定はどれも無し(既定の操作を変えない)。ここは出来事の見分けと、保存の値の読み取りだけを持つ純関数。
 */

export const POINTER_COMMAND_INPUTS = ['back', 'forward', 'middleDouble'] as const;
export type PointerCommandInput = typeof POINTER_COMMAND_INPUTS[number];
/** 入力ごとの命令。割り当てていない入力は欄が無い。 */
export type MouseButtonCommands = Readonly<Partial<Record<PointerCommandInput, CommandId>>>;
export const EMPTY_MOUSE_BUTTON_COMMANDS: MouseButtonCommands = Object.freeze({});

/** 中ボタンの 2 回の押下をダブルクリックとみなす間隔(ms)と、押して離すまでに動いてよい距離(CSS 画素)。 */
export const MIDDLE_DOUBLE_GAP_MS = 400;
export const MIDDLE_DOUBLE_SLOP_PX = 4;

/** 見分けに使う出来事の欄(PointerEvent・MouseEvent の一部)。 */
interface PointerCommandEvent {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp: number;
}

/**
 * 押下と離した出来事から入力を見分ける(状態を持つ)。button 3 は戻る、4 は進む。中ボタンは、押して離すまでの移動が
 * MIDDLE_DOUBLE_SLOP_PX 以下の押下が MIDDLE_DOUBLE_GAP_MS の内に 2 回続いた時だけダブルクリック(中ボタンの回転の
 * ドラッグを続けても受けない)。
 */
export function createPointerCommandGesture() {
  let middleDown: PointerCommandEvent | null = null;
  let lastMiddleClick: number | null = null;
  return {
    down(event: PointerCommandEvent): void {
      if (event.button === 1) middleDown = event;
    },
    up(event: PointerCommandEvent): PointerCommandInput | null {
      if (event.button === 3) return 'back';
      if (event.button === 4) return 'forward';
      if (event.button !== 1 || middleDown === null) return null;
      const still = Math.hypot(event.clientX - middleDown.clientX, event.clientY - middleDown.clientY) <= MIDDLE_DOUBLE_SLOP_PX;
      middleDown = null;
      if (!still) { lastMiddleClick = null; return null; }
      if (lastMiddleClick !== null && event.timeStamp - lastMiddleClick <= MIDDLE_DOUBLE_GAP_MS) {
        lastMiddleClick = null;
        return 'middleDouble';
      }
      lastMiddleClick = event.timeStamp;
      return null;
    },
  };
}

/** 保存の値を読む。知らない入力・登録の無い命令はその 1 件だけ捨て、捨てた数を返す。 */
export function readMouseButtonCommands(raw: unknown): { readonly commands: MouseButtonCommands; readonly dropped: number } {
  if (raw === undefined) return { commands: EMPTY_MOUSE_BUTTON_COMMANDS, dropped: 0 };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { commands: EMPTY_MOUSE_BUTTON_COMMANDS, dropped: 1 };
  const commands: Partial<Record<PointerCommandInput, CommandId>> = {};
  let dropped = 0;
  for (const [input, id] of Object.entries(raw)) {
    const known = POINTER_COMMAND_INPUTS.find(item => item === input);
    const definition = typeof id === 'string' ? commandDefinition(id) : null;
    if (known === undefined || definition === null) { dropped += 1; continue; }
    commands[known] = definition.id;
  }
  return { commands: Object.freeze(commands), dropped };
}
