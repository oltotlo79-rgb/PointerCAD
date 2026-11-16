import { attachPointerCommands } from '../commands/attachPointerCommands.js';
import { executeCommand } from '../commands/commandRegistry.js';
import { EMPTY_MOUSE_BUTTON_COMMANDS } from '../commands/pointerCommandGesture.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachDrawingNavigation } from './drawingNavigation.js';

/**
 * 図面の面の入力: 表示の移動・拡大縮小(attachDrawingNavigation)と、マウスの戻る・進む・中ボタンのダブルクリックの
 * 命令(B-08e。3D のビューポートと同じ受け手)。外す時は両方を外す。
 */
export function attachDrawingSurfaceInputs(...args: Parameters<typeof attachDrawingNavigation>): ReturnType<typeof attachDrawingNavigation> {
  const [surface] = args;
  const navigation = attachDrawingNavigation(...args);
  const detachCommands = attachPointerCommands(surface,
    () => useAppStore.getState().displaySettings.mouseButtonCommands ?? EMPTY_MOUSE_BUTTON_COMMANDS, (id) => { executeCommand(id); });
  return { ...navigation, detach: () => { detachCommands(); navigation.detach(); } };
}
