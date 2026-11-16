import { attachPointerCommands } from '../commands/attachPointerCommands.js';
import { executeCommand } from '../commands/commandRegistry.js';
import { EMPTY_MOUSE_BUTTON_COMMANDS } from '../commands/pointerCommandGesture.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachDrawingNavigation } from './drawingNavigation.js';
import { attachDrawingTouch } from './drawingTouch.js';

/**
 * 図面の面の入力: 表示の移動・拡大縮小(attachDrawingNavigation)、マウスの戻る・進む・中ボタンのダブルクリックの
 * 命令(B-08e。3D のビューポートと同じ受け手)と、タッチの 2 本指(B-08g。割り当てた時だけ)。外す時は全部を外す。
 */
export function attachDrawingSurfaceInputs(...args: Parameters<typeof attachDrawingNavigation>): ReturnType<typeof attachDrawingNavigation> {
  const [surface, options] = args;
  const navigation = attachDrawingNavigation(...args);
  const detachCommands = attachPointerCommands(surface,
    () => useAppStore.getState().displaySettings.mouseButtonCommands ?? EMPTY_MOUSE_BUTTON_COMMANDS, (id) => { executeCommand(id); });
  const detachTouch = attachDrawingTouch(surface, options);
  return { ...navigation, detach: () => { detachTouch(); detachCommands(); navigation.detach(); } };
}
