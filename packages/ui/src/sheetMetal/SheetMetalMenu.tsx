import { SheetBaseIcon, SheetFlangeIcon, SheetLineBendIcon, SheetReliefIcon } from '../shell/icons.js';
import { ToolMenu } from '../shell/menus/ToolMenu.js';
import type { ToolMenuItem } from '../shell/menus/menuItem.js';
import type { SheetMetalToolKind } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';

const items: readonly ToolMenuItem<SheetMetalToolKind>[] = [
  { id: 'sheetBase', labelKey: 'sheetMetal.base', tooltipKey: 'sheetMetal.baseHint', Icon: SheetBaseIcon },
  { id: 'sheetFlange', labelKey: 'sheetMetal.flange', tooltipKey: 'sheetMetal.flangeHint', Icon: SheetFlangeIcon },
  { id: 'sheetBend', labelKey: 'sheetMetal.lineBend', tooltipKey: 'sheetMetal.lineBendHint', Icon: SheetLineBendIcon },
  { id: 'sheetRelief', labelKey: 'sheetMetal.relief', tooltipKey: 'sheetMetal.reliefHint', Icon: SheetReliefIcon },
  { id: 'sheetUnfold', labelKey: 'sheetMetal.unfold', tooltipKey: 'sheetMetal.unfoldHint', Icon: SheetBaseIcon },
];
export function SheetMetalMenu(): React.JSX.Element {
  const active = useAppStore((state) => state.sheetMetalTool?.kind ?? 'select');
  return <ToolMenu items={items} groupLabelKey="sheetMetal.title" groupTooltipKey="sheetMetal.groupHint" GroupIcon={SheetFlangeIcon}
    activeTool={active} onChoose={(kind, pressed) => {
      const state = useAppStore.getState();
      if (pressed) state.closeSheetMetalTool(); else state.openSheetMetalTool(kind);
    }} />;
}
