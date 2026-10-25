import { describe, expect, it } from 'vitest';
import { findHelpTopic } from '@pointercad/help-content';
import { TOOLBAR_COMMAND_CATALOG, toolbarCommandId } from './toolbarCommandCatalog.js';
import { COMMAND_DEFINITIONS, commandDefinition } from './commandDefinitions.js';

describe('toolbar command catalog', () => {
  it('部品・組立・板金・図面の操作を登録し、保存の別入口を二重に割り当てない', () => {
    const originalGroups = TOOLBAR_COMMAND_CATALOG.filter(entry => !['sheetMetal', 'script', 'drawing', 'view', 'plane', 'reference', 'snap', 'assemblyUtility'].includes(entry.group));
    // GR-30 が「見た目」へ「図形の測定値」を1行足したので 109 → 110(Q1=A4)。
    // R16 adds exactly one shared save-point command; drawing aliases it.
    // 追加要件6 が「組む」へ「ボルトで締結」「締結を外す」の2項目を足したので 111 → 113。
    // 溶接(weld-beads-r1)が「組む」へ「すみ肉溶接」の1項目を足したので 113 → 114。
    // 面の移動は加工へ1項目だけ追加し、既存114項目を保つ。
    // EX-13 adds midpoint, point-on-curve and the two signed axis distances: 115 -> 119.
    const addedConstraints = ['midpoint', 'pointOnCurve', 'horizontalDistance', 'verticalDistance'];
    expect(originalGroups).toHaveLength(119);
    expect(originalGroups.filter(entry => entry.group === 'constraint' && addedConstraints.includes(entry.sourceId)))
      .toMatchObject(addedConstraints.map(sourceId => ({
        id: toolbarCommandId('constraint', sourceId), group: 'constraint', sourceId,
        labelKey: `constraint.kind.${sourceId}`, tooltipKey: `toolbar.constraint.${sourceId}Tooltip`, helpTopic: 'constraints',
      })));
    const previousGroups = originalGroups.filter(entry => entry.group !== 'constraint' || !addedConstraints.includes(entry.sourceId));
    expect(previousGroups).toHaveLength(115);
    expect(previousGroups.filter(entry => entry.sourceId !== 'faceOffset')).toHaveLength(114);
    expect(originalGroups.filter(entry => entry.sourceId === 'faceOffset')).toEqual([
      expect.objectContaining({ id: toolbarCommandId('solidMachining', 'faceOffset'),
        group: 'solidMachining', labelKey: 'toolbar.machining.faceOffset' }),
    ]);
    expect(new Set(TOOLBAR_COMMAND_CATALOG.map((entry) => entry.id)).size).toBe(TOOLBAR_COMMAND_CATALOG.length);
    expect(TOOLBAR_COMMAND_CATALOG.filter(item => item.group === 'sheetMetal')).toHaveLength(5);
    expect(TOOLBAR_COMMAND_CATALOG.filter(item => item.group === 'drawing').length).toBeGreaterThan(35);
    expect(TOOLBAR_COMMAND_CATALOG.find((entry) => entry.id === 'file.save')?.labelKey).toBe('toolbar.file.save');
    expect(TOOLBAR_COMMAND_CATALOG.find((entry) => entry.id === 'file.saveAs')?.sourceId).toBe('saveAs');
  });

  it('keeps generated IDs stable while reusing descriptor source IDs', () => {
    expect(toolbarCommandId('shape', 'rectangle')).toBe('toolbar.shape.rectangle');
    expect(toolbarCommandId('solidCombine', 'subtract')).toBe('toolbar.solidCombine.subtract');
  });

  it.each([
    ['annotation', 'surface-finish'], ['note', 'drawing-note'], ['refreshSource', 'drawing'],
    ['centerMark', 'drawing-views'], ['hidden', 'drawing-views'], ['centers', 'drawing-views'],
    ['return', 'drawing-export'], ['datum', 'gdt'], ['weld', 'welding'],
  ])('図面の%sは同じメニュー内の別操作ではなく、その操作の説明を開く', (action, topic) => {
    expect(commandDefinition(toolbarCommandId('drawing', action))?.helpTopic).toBe(topic);
    expect(findHelpTopic(topic)).toBeDefined();
  });

  it('全項目に実際の実行登録と存在する説明を持ち、一覧から黙って落とさない', () => {
    for (const entry of TOOLBAR_COMMAND_CATALOG) {
      expect(commandDefinition(entry.id)?.labelKey, entry.id).toBe(entry.labelKey);
      expect(findHelpTopic(entry.helpTopic), entry.id).toBeDefined();
    }
    for (const definition of COMMAND_DEFINITIONS) expect(findHelpTopic(definition.helpTopic), definition.id).toBeDefined();
    expect(toolbarCommandId('drawing', 'saveAs')).toBe('file.saveAs');
    expect(toolbarCommandId('drawing', 'open')).toBe('file.open');
  });
});

it('保存点は部品・組立・図面で同じcommand IDと説明を使い、二重登録しない', () => {
  const id = toolbarCommandId('fileMenu', 'savePoints');
  expect(toolbarCommandId('drawing', 'savePoints')).toBe(id);
  expect(TOOLBAR_COMMAND_CATALOG.filter(entry => entry.id === id)).toHaveLength(1);
  expect(commandDefinition(id)?.documentKinds).toEqual(['part', 'assembly', 'drawing']);
  expect(commandDefinition(id)?.helpTopic).toBe('save-and-open');
});
