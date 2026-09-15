import { SHEET_METAL_MENU_ITEMS } from './sheetMetalMenuItems.js';
import { SheetFlangeIcon } from '../shell/icons.js';
import { ToolMenu } from '../shell/menus/ToolMenu.js';
import { useAppStore } from '../store/useAppStore.js';

export function SheetMetalMenu(): React.JSX.Element {
  const active = useAppStore((state) => state.sheetMetalTool?.kind ?? 'select');
  return <ToolMenu items={SHEET_METAL_MENU_ITEMS} groupLabelKey="sheetMetal.title" groupTooltipKey="sheetMetal.groupHint" GroupIcon={SheetFlangeIcon}
    activeTool={active} commandGroup="sheetMetal" />;
}
