import { PART_EXAMPLES, PART_SCHEMA_VERSION } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readPcadFile, writePcadFile } from './pcadFile.js';

const SAVED_AT = '2026-11-20T00:00:00.000Z';

describe('作例の文書は今の保存の形で書けて、読み直すと同じ文書に戻る(J-06b)', () => {
  it.each(PART_EXAMPLES.map(example => [example.id, example] as const))('%s', (_id, example) => {
    const document = example.create();
    expect(document.schemaVersion).toBe(PART_SCHEMA_VERSION);
    const result = readPcadFile(writePcadFile(document, { savedAt: SAVED_AT }));
    if (!result.ok) throw new Error(`読み込みに失敗しました: ${result.error.code} / ${result.error.message}`);
    expect(result.document).toEqual(document);
    expect(result.savedAt).toBe(SAVED_AT);
  });
});
