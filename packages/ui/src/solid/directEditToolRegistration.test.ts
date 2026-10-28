import { beforeEach, describe, expect, it } from 'vitest';
import { findHelpTopic } from '@pointercad/help-content';
import { toolbarCommand } from '../commands/toolbarCommandCatalog.js';
import { commandDefinition } from '../commands/commandDefinitions.js';
import { t } from '../i18n/t.js';
import { MACHINING_MENU_ITEMS } from '../shell/menus/solidMenuItems.js';
import { runSolidTool } from '../shell/menus/solidToolActions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SOLID_TOOL_STEPS } from '../sketch/numericInput.js';
import { keepsSelectionKind } from './subShapeSelection.js';

beforeEach(resetTestStore);
describe('direct edit tool registration', () => {
  it.each(['holeTranslate', 'faceRotate'] as const)('%s shares menu, command, input and F1 topic', tool => {
    const menu = MACHINING_MENU_ITEMS.find(item => item.id === tool);
    const command = toolbarCommand(`toolbar.solidMachining.${tool}`);
    expect(menu).toBeDefined();
    expect(command).toMatchObject({ sourceId: tool, group: 'solidMachining', helpTopic: 'shape-edit' });
    expect(commandDefinition(`toolbar.solidMachining.${tool}`)?.helpTopic).toBe('shape-edit');
    expect(findHelpTopic('shape-edit')).toBeDefined();
    if (menu === undefined) throw new Error('Missing menu');
    expect(t(menu.labelKey)).not.toBe(menu.labelKey);
    expect(t(menu.tooltipKey)).not.toBe(menu.tooltipKey);
    expect(keepsSelectionKind(tool)).toBe(true);
    const selection = tool === 'holeTranslate' ? ['body#face:0'] : ['body#edge:0', 'body#face:0'];
    useAppStore.getState().setSelection(selection);
    runSolidTool(tool, { ready: true, reasonKey: null });
    expect(useAppStore.getState().selection).toEqual(selection);
    expect(useAppStore.getState().numericInput).toMatchObject({ toolId: tool, step: SOLID_TOOL_STEPS[tool] });
  });
  it.each(['holeTranslate', 'faceRotate'] as const)('%s starts face picking and shows the selection reason', tool => {
    const reasonKey = tool === 'holeTranslate' ? 'directEditError.oneCylinder' : 'directEditError.faceAndEdge';
    runSolidTool(tool, { ready: false, reasonKey });
    expect(useAppStore.getState().solidErrorKey).toBe(reasonKey);
    expect(useAppStore.getState().selectionKind).toBe('face');
    expect(useAppStore.getState().numericInput).toBeNull();
  });
});
