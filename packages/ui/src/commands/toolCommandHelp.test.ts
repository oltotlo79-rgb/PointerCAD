import { beforeEach, describe, expect, it } from 'vitest';
import { findHelpTopic } from '@pointercad/help-content';
import { toolCommandHelpTopic } from './toolCommandHelp.js';
import { commandDefinition } from './commandDefinitions.js';
import { toolbarCommand } from './toolbarCommandCatalog.js';
import { executeCommand } from './commandRegistry.js';
import { contextualHelpTopic } from '../help/helpContext.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createNumericInput, EDIT_TOOL_STEPS, SHAPE_TOOL_STEPS, SOLID_TOOL_STEPS, REFERENCE_TOOL_STEPS } from '../sketch/numericInput.js';

beforeEach(resetTestStore);
describe('道具・入力・編集中の形から該当する説明へ進む', () => {
  it.each([
    ['extrude', 'solid-basics'], ['threadHole', 'thread'], ['fillet', 'fillet-chamfer'], ['sphereGridPoint', 'sphere-grid'],
    ['loft', 'ruled-loft'], ['sweep', 'shape-edit'], ['sketchFillet', 'sketch-fillet'], ['projectedCurve', 'project-intersect'],
    ['ellipse', 'ellipse'], ['spline', 'spline'], ['text', 'text-sketch'], ['referenceAxis', 'reference-geometry'],
    ['referencePlaneTilted', 'work-plane-custom'], ['measure', 'measure'],
    ['sew', 'solid-combine'], ['threadShaft', 'thread'],
  ])('%sの説明を無関係なスケッチ章へ送らない', (tool, topic) => {
    expect(toolCommandHelpTopic(tool)).toBe(topic);
    expect(findHelpTopic(topic)).toBeDefined();
  });
  it('入力段のある全道具は、入力欄から開く説明を持つ', () => {
    for (const tool of new Set([...Object.keys(EDIT_TOOL_STEPS), ...Object.keys(SHAPE_TOOL_STEPS),
      ...Object.keys(SOLID_TOOL_STEPS), ...Object.keys(REFERENCE_TOOL_STEPS), 'point', 'line', 'arc', 'pointArray'])) {
      const topic = toolCommandHelpTopic(tool);
      expect(topic, tool).toBeDefined(); expect(findHelpTopic(topic ?? ''), tool).toBeDefined();
    }
    expect(toolCommandHelpTopic('missing')).toBeUndefined();
  });
  it('画面のF1は選択中の道具へ進み、入力欄の明示された説明と値を保持する', () => {
    useAppStore.getState().setActiveTool('extrude');
    const input = createNumericInput('extrude', SOLID_TOOL_STEPS.extrude);
    useAppStore.getState().openNumericInput(input, [100, 100]);
    const before = useAppStore.getState();
    expect(contextualHelpTopic(before)).toBe('solid-basics');
    expect(contextualHelpTopic(before, toolCommandHelpTopic(input.toolId), true)).toBe('solid-basics');
    expect(useAppStore.getState()).toBe(before);
  });
  it('縫合のメニュー・対象選択中・数値入力中は、縫合と許容差のある章へ案内する', () => {
    const commandId = 'toolbar.solidCreate.sew';
    expect(toolbarCommand(commandId)?.helpTopic).toBe('solid-combine');
    expect(commandDefinition(commandId)?.helpTopic).toBe('solid-combine');
    const initial = useAppStore.getState();
    expect(contextualHelpTopic(initial, commandDefinition(commandId)?.helpTopic)).toBe('solid-combine');
    expect(executeCommand(commandId).status).toBe('executed');
    expect(useAppStore.getState().numericInput).toBeNull();
    expect(contextualHelpTopic(useAppStore.getState())).toBe('solid-combine');
    const input = createNumericInput('sew', SOLID_TOOL_STEPS.sew);
    useAppStore.getState().openNumericInput(input, [100, 100]);
    const beforeHelp = useAppStore.getState();
    expect(contextualHelpTopic(beforeHelp, toolCommandHelpTopic(input.toolId), true)).toBe('solid-combine');
    expect(executeCommand('help.contextual').status).toBe('executed');
    expect(useAppStore.getState().helpTopicId).toBe('solid-combine');
    expect(useAppStore.getState().numericInput).toBe(beforeHelp.numericInput);
    expect(useAppStore.getState().document).toBe(initial.document);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});
