import { findHelpTopic } from '@pointercad/help-content';
import { describe, expect, it } from 'vitest';
import { commandDefinition } from './commandDefinitions.js';
import { radialCommandAt, radialCommandIds, radialCommandDescription } from './radialCommandItems.js';
import { t } from '../i18n/t.js';

describe('放射メニューは画面の8道具を既存の操作入口へつなぐ', () => {
  it.each(['part', 'assembly', 'drawing'] as const)('%sの全方向に固有で実行範囲が一致する操作と説明を持つ', kind => {
    const ids = radialCommandIds(kind);
    expect(ids).toHaveLength(8); expect(new Set(ids).size).toBe(8);
    for (const slot of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
      const definition = commandDefinition(ids[slot]);
      expect(radialCommandAt(kind, slot)).toBe(ids[slot]);
      expect(definition?.documentKinds).toContain(kind);
      expect(findHelpTopic(definition?.helpTopic ?? '')).toBeDefined();
      expect(radialCommandDescription(ids[slot])).not.toBe(t('radial.unavailable'));
      expect(radialCommandDescription(ids[slot]).trim()).not.toBe('');
    }
  });
});
