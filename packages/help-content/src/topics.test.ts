import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findHelpTopic, HELP_TOPICS } from './index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('ヘルプの目録', () => {
  it('目録に載っている Markdown はすべて実在する', () => {
    for (const topic of HELP_TOPICS) {
      expect(existsSync(resolve(packageRoot, topic.path)), topic.path).toBe(true);
    }
  });

  it('id が重複しない', () => {
    const ids = HELP_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ビューポートの説明を id で引ける(FR-903 の土台)', () => {
    expect(findHelpTopic('viewport')?.path).toBe('docs/ja/viewport.md');
  });

  it('存在しない id では undefined を返す', () => {
    expect(findHelpTopic('この項目はない')).toBeUndefined();
  });

  it('面と面をつなぐ・ロフトの説明を id で引ける(FR-430、FR-410、P5 タスク27)', () => {
    expect(findHelpTopic('ruled-loft')?.path).toBe('docs/ja/ruled-loft.md');
  });

  it('測定の説明を id で引ける(FR-1102、P5 タスク32)', () => {
    expect(findHelpTopic('measure')?.path).toBe('docs/ja/measure.md');
  });

  it('質量特性の説明を id で引ける(FR-1101、P5 タスク32)', () => {
    expect(findHelpTopic('mass-properties')?.path).toBe('docs/ja/mass-properties.md');
  });
});
