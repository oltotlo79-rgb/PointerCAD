import { SheetBaseIcon, SheetFlangeIcon, SheetLineBendIcon, SheetReliefIcon } from '../shell/icons.js';
import type { ToolMenuItem } from '../shell/menus/menuItem.js';
import type { SheetMetalToolKind } from '../store/sheetMetalSlice.js';

export const SHEET_METAL_MENU_ITEMS: readonly ToolMenuItem<SheetMetalToolKind>[] = [
  { id: 'sheetBase', labelKey: 'sheetMetal.base', tooltipKey: 'sheetMetal.baseHint', Icon: SheetBaseIcon },
  { id: 'sheetFlange', labelKey: 'sheetMetal.flange', tooltipKey: 'sheetMetal.flangeHint', Icon: SheetFlangeIcon },
  { id: 'sheetBend', labelKey: 'sheetMetal.lineBend', tooltipKey: 'sheetMetal.lineBendHint', Icon: SheetLineBendIcon },
  { id: 'sheetRelief', labelKey: 'sheetMetal.relief', tooltipKey: 'sheetMetal.reliefHint', Icon: SheetReliefIcon },
  { id: 'sheetUnfold', labelKey: 'sheetMetal.unfold', tooltipKey: 'sheetMetal.unfoldHint', Icon: SheetBaseIcon },
];
