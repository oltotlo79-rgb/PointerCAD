import { describe, expect, it } from 'vitest';
import { findHelpTopic } from '@pointercad/help-content';
import { TOOLBAR_COMMAND_CATALOG, toolbarCommandId } from './toolbarCommandCatalog.js';
import { COMMAND_DEFINITIONS, commandDefinition } from './commandDefinitions.js';

describe('toolbar command catalog', () => {
  it('部品・組立・板金・図面の操作を登録し、保存の別入口を二重に割り当てない', () => {
    const originalGroups = TOOLBAR_COMMAND_CATALOG.filter(entry => !['sheetMetal', 'script', 'drawing', 'view', 'plane', 'reference', 'snap', 'assemblyUtility'].includes(entry.group));
    expect(originalGroups).toHaveLength(109);
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
