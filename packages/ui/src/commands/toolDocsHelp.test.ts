import { readFileSync } from 'node:fs';
import { appendSolid, type SolidBody } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeCommand } from './commandRegistry.js';
import { toolbarCommandId } from './toolbarCommandCatalog.js';
import { toolCommandHelpTopic } from './toolCommandHelp.js';
import { t } from '../i18n/t.js';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import { commitNumericInput, SOLID_TOOL_STEPS } from '../sketch/numericInput.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { bodyFor, extrudeFeature, holeFeature, partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

function helpText(topic: string): string {
  return readFileSync(new URL(`../../../help-content/docs/ja/${topic}.md`, import.meta.url), 'utf8');
}

const TOOL_CASES = [
  { tool: 'cut', group: 'solidMachining', topic: 'cut', target: 'body' },
  { tool: 'hole', group: 'solidMachining', topic: 'hole', target: 'hole' },
  { tool: 'threadHole', group: 'solidMachining', topic: 'thread', target: 'hole' },
  { tool: 'fillet', group: 'solidMachining', topic: 'fillet-chamfer', target: 'edge' },
  { tool: 'chamfer', group: 'solidMachining', topic: 'fillet-chamfer', target: 'edge' },
  { tool: 'linearPattern', group: 'solidMachining', topic: 'pattern', target: 'pattern' },
  { tool: 'circularPattern', group: 'solidMachining', topic: 'pattern', target: 'pattern' },
  { tool: 'spring', group: 'solidCreate', topic: 'spring', target: 'point' },
  { tool: 'threadShaft', group: 'solidMachining', topic: 'thread', target: 'cylinder' },
] as const;

/** Geometry is supplied here only for picking; real shape generation is checked in the screen tests. */
function prepareTargets(target: typeof TOOL_CASES[number]['target']): readonly string[] {
  const base = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
  const patterned = target === 'pattern';
  const document = patterned ? appendSolid(base, holeFeature('hole-1', 'extrude-1')) : base;
  const bodyId = patterned ? 'hole-1' : 'extrude-1';
  const body: SolidBody = {
    ...bodyFor(bodyId),
    faces: [{ index: 0, surfaceKind: target === 'cylinder' ? 'cylinder' : 'plane',
      area: 100, centroid: [0, 0, 3], axis: [0, 0, 1], radius: target === 'cylinder' ? 3 : null,
      triangleOffset: 0, triangleCount: 1 }],
    edges: [{ index: 0, curveKind: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0],
      midpoint: [5, 0, 0], axis: null, radius: null, segmentOffset: 0, segmentCount: 1 }],
  };
  useAppStore.getState().resetDocument(document);
  useAppStore.setState({ bodies: [body], isComputing: false });
  switch (target) {
    case 'body': case 'pattern': return [bodyId];
    case 'point': return ['point-1'];
    case 'edge': return [subShapeElementId(bodyId, 'edge', 0)];
    case 'cylinder': return [subShapeElementId(bodyId, 'face', 0)];
    case 'hole': return [subShapeElementId(bodyId, 'face', 0), 'point-1'];
  }
}

describe('説明書どおり対象を選ぶ前に加工の道具を始める', () => {
  it.each(TOOL_CASES)('$tool は案内後に対象を選び、同じ道具から入力して履歴を確定できる', ({ tool, group, topic, target }) => {
    const selection = prepareTargets(target);
    const initial = useAppStore.getState();
    const commandId = toolbarCommandId(group, tool);
    expect(executeCommand(commandId).status).toBe('executed');
    const waiting = useAppStore.getState();
    expect(waiting.activeTool).toBe(tool);
    expect(waiting.solidErrorKey).not.toBeNull();
    expect(waiting.numericInput).toBeNull();
    expect(waiting.document).toBe(initial.document);
    expect(waiting.canUndo).toBe(false);

    waiting.setSelection(selection);
    expect(executeCommand(commandId).status).toBe('executed');
    const input = useAppStore.getState().numericInput;
    expect(input?.step).toBe(SOLID_TOOL_STEPS[tool]);
    expect(useAppStore.getState().selection).toEqual(selection);
    expect(useAppStore.getState().solidErrorKey).toBeNull();
    expect(useAppStore.getState().document).toBe(initial.document);
    if (input === null) throw new Error('Tool must open numeric input after selection');
    let transition = commitNumericInput(input);
    if (tool === 'spring') {
      expect(transition.kind).toBe('open');
      applyNumericTransition(transition);
      const lengthInput = useAppStore.getState().numericInput;
      expect(lengthInput?.step).toBe('springLength');
      expect(useAppStore.getState().document).toBe(initial.document);
      if (lengthInput === null) throw new Error('Spring length input must remain open');
      transition = commitNumericInput(lengthInput);
    }
    expect(transition.kind).toBe('solidCommitted');
    applyNumericTransition(transition);
    const committed = useAppStore.getState();
    expect(committed.numericInput).toBeNull();
    expect(committed.activeTool).toBe('select');
    expect(committed.document.solids).toHaveLength(initial.document.solids.length + 1);
    const feature = committed.document.solids.at(-1);
    if (tool === 'linearPattern' || tool === 'circularPattern') {
      expect(feature?.kind).toBe('pattern');
      if (feature?.kind !== 'pattern') throw new Error('Pattern feature must be committed');
      expect(feature.placement.kind).toBe(tool === 'linearPattern' ? 'linear' : 'circular');
    } else {
      expect(feature?.kind).toBe(tool);
    }
    expect(committed.selection).toEqual([feature?.id]);
    expect(committed.canUndo).toBe(true);
    expect(toolCommandHelpTopic(tool)).toBe(topic);
    expect(helpText(topic)).toContain('選ぶ前でも');
    expect(helpText(topic)).toContain('もう一度');
    expect(helpText(topic)).not.toContain('ボタンは薄いままで押せません');
    committed.undo();
    expect(useAppStore.getState().document).toEqual(initial.document);
  });
});

describe('作図と加工の説明を実際の操作に合わせる', () => {
  it('最後の道具の図柄を押すと一覧を開く手順を案内する', () => {
    const text = helpText('sketch-tools');
    expect(text).toContain('次にそのボタンを押すと、道具の一覧が開きます');
    expect(text).toContain('同じ道具を使うときも、一覧からその道具を選んでください');
    expect(text).not.toContain('一覧を開かずにそのボタンを 1 回押すだけ');
  });

  it('外ねじの説明に対象・入力・端・表現・再編集と保存を欠かさない', () => {
    const text = helpText('thread');
    const section = text.slice(text.indexOf('## 外ねじ(おねじ)を作る'));
    expect(section).toContain('丸い側面');
    for (const label of ['外ねじの大きさ', '呼び', 'ねじの種類', 'ピッチ', '長さ',
      '切り始める端', '手前の端', '奥の端', '実際のねじ山を作る', 'プロパティ', 'ねじ部の長さ']) {
      expect(section, label).toContain(`「${label}」`);
    }
    expect(section).toContain('視点を回しても入れ替わりません');
    expect(section).toContain('もとの軸の直径は変わりません');
    expect(section).toContain('ピッチは規格の値に戻ります');
    expect(section).toContain('Ctrl+Z');
    expect(section).toContain('save-and-open.md');
    expect(section).toContain('### 外ねじがうまくいかないとき');
  });

  it('縫合の案内先には、縫合の手順と許容差の説明がある', () => {
    const text = helpText(toolCommandHelpTopic('sew') ?? 'missing');
    expect(text).toContain('縫合');
    expect(text).toContain(t('numericInput.field.tolerance'));
  });
});
