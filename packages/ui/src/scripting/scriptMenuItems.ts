import type { ToolMenuItem } from '../shell/menus/menuItem.js';
import { ScriptCodeIcon } from './ScriptIcons.js';

export const SCRIPT_MENU_ITEMS = [
  { id: 'script-editor', labelKey: 'script.title', tooltipKey: 'script.tooltip', Icon: ScriptCodeIcon },
] as const satisfies readonly ToolMenuItem<string>[];
