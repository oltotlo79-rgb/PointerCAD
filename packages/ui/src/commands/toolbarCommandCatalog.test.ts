import { describe, expect, it } from 'vitest';
import { findHelpTopic } from '@pointercad/help-content';
import { TOOLBAR_COMMAND_CATALOG, toolbarCommandId } from './toolbarCommandCatalog.js';
import { COMMAND_DEFINITIONS, commandDefinition } from './commandDefinitions.js';

describe('toolbar command catalog', () => {
  it('部品・組立・板金・図面の操作を登録し、保存の別入口を二重に割り当てない', () => {
    const originalGroups = TOOLBAR_COMMAND_CATALOG.filter(entry => !['sheetMetal', 'script', 'drawing', 'view', 'plane', 'reference', 'snap', 'assemblyUtility'].includes(entry.group));
    // GR-30 が「見た目」へ「図形の測定値」を1行足したので 109 → 110(Q1=A4)。
    expect(originalGroups).toHaveLength(110);
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
