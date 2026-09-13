import { describe, expect, it } from 'vitest';
import { HELP_TOPICS } from './topics.js';
import { buildManualManifest, MANUAL_CHAPTERS, MANUAL_VOLUMES } from './manualManifest.js';

describe('ヘルプと分冊の単一目録', () => {
  it('すべての既存章を一度だけ収録し、題名と本文の参照先を共有する', () => {
    expect(MANUAL_CHAPTERS).toHaveLength(HELP_TOPICS.length);
    expect(new Set(MANUAL_CHAPTERS.map(chapter => chapter.id))).toEqual(new Set(HELP_TOPICS.map(topic => topic.id)));
    for (const [index, chapter] of MANUAL_CHAPTERS.entries()) {
      expect(chapter.order).toBe(index);
      expect(chapter).toMatchObject(HELP_TOPICS.find(topic => topic.id === chapter.id) ?? {});
      expect(MANUAL_VOLUMES.some(volume => volume.id === chapter.volumeId)).toBe(true);
    }
  });
  it('新しい章の割当忘れ、本文の脱落、二重掲載を生成前に拒否する', () => {
    expect(() => buildManualManifest([...HELP_TOPICS, { id: 'new-tool', title: '新しい道具', path: 'docs/ja/new-tool.md' }], MANUAL_VOLUMES)).toThrow('Unassigned');
    expect(() => buildManualManifest(HELP_TOPICS.slice(1), MANUAL_VOLUMES)).toThrow('Missing');
    const first = MANUAL_VOLUMES[0];
    expect(() => buildManualManifest(HELP_TOPICS, [{ ...first, topics: [...first.topics, first.topics[0]] }, ...MANUAL_VOLUMES.slice(1)])).toThrow('duplicate');
  });
  it('別のファイルへ抜ける参照や重複巻を拒否する', () => {
    expect(() => buildManualManifest([{ id: 'a', title: 'A', path: '../outside.md' }], [{ id: 'a', title: '巻', topics: ['a'] }])).toThrow('Invalid help');
    expect(() => buildManualManifest(HELP_TOPICS, [...MANUAL_VOLUMES, MANUAL_VOLUMES[0]])).toThrow('Invalid manual volume');
  });
});
