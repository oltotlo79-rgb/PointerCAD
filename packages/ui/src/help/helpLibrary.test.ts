import { HELP_TOPICS } from '@pointercad/help-content';
import { describe, expect, it, vi } from 'vitest';
import { HELP_IMAGES, HELP_LOADERS } from './helpContent.js';
import { DRAWING_TOOL_GROUPS } from '../drawing/drawingToolbarItems.js';
import { createHelpLibrary, resolveHelpLink } from './helpLibrary.js';

describe('同梱ヘルプの本文と検索', () => {
  it('目録の全章に本文があり、実際の動的読込も空にならない', async () => {
    expect(Object.keys(HELP_LOADERS).sort()).toEqual(HELP_TOPICS.map((topic) => topic.id).sort());
    for (const topic of HELP_TOPICS) expect((await HELP_LOADERS[topic.id]?.())?.trim().startsWith('#'), topic.path).toBe(true);
    for (const group of DRAWING_TOOL_GROUPS) expect(HELP_LOADERS[group.helpTopic], group.label).toBeDefined();
  });
  it('本文の実画面リンクが同梱画像へ解決され、P8の17章・構成とP9の2章は画像を持つ', async () => {
    const required = new Set(['drawing', 'drawing-views', 'drawing-section', 'drawing-scale', 'dimension', 'dimension-auto',
      'dimension-series', 'dimension-tolerance', 'dimension-arrange', 'surface-finish', 'drawing-note', 'drawing-layer',
      'drawing-bom', 'drawing-table', 'drawing-export', 'text-outline', 'named-view', 'parameters', 'gdt', 'welding',
      'sheet-metal', 'sheet-metal-flange', 'sheet-metal-bend-relief', 'sheet-metal-flat', 'sketch-intersections', 'strength', 'dxf', 'ruled-loft', 'shape-edit', 'cam', 'scripts', 'script-api', 'script-tools']);
    for (const topic of HELP_TOPICS) {
      const text = await HELP_LOADERS[topic.id]();
      const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)];
      if (required.has(topic.id)) expect(images.length, topic.id).toBeGreaterThan(0);
      for (const image of images) expect(HELP_IMAGES[image[1]], `${topic.id}: ${image[1]}`).toBeDefined();
    }
  });
  it('本文をキャッシュし、同時要求でも一度しか読まない', async () => {
    const loader = vi.fn(() => Promise.resolve('# 図面')); const library = createHelpLibrary({ drawing: loader });
    expect(await Promise.all([library.load('drawing'), library.load('drawing')])).toEqual(['# 図面', '# 図面']);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it('失敗した本文は再試行でき、不明な章を成功扱いにしない', async () => {
    const loader = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('# 再試行');
    const library = createHelpLibrary({ drawing: loader });
    await expect(library.load('drawing')).rejects.toThrow('offline');
    await expect(library.load('drawing')).resolves.toBe('# 再試行');
    await expect(library.load('absent')).rejects.toThrow('Unknown help topic');
  });
  it('日本語の本文もAND検索し、全半角の違いを吸収する', async () => {
    const library = createHelpLibrary(Object.fromEntries(HELP_TOPICS.map((topic) => [topic.id, () => Promise.resolve(topic.id === 'drawing' ? '公差は0.1 mm、印刷を選ぶ' : '別の説明')])));
    expect((await library.search('公差 ０．１')).topics.map((topic) => topic.id)).toEqual(['drawing']);
    expect((await library.search('公差 不在')).topics).toEqual([]);
    expect((await library.search('   ')).topics).toEqual(HELP_TOPICS);
  });
  it('一章の読込失敗で検索全体を消さず、失敗数を返す', async () => {
    const library = createHelpLibrary({ drawing: () => Promise.resolve('公差') });
    const result = await library.search('公差');
    expect(result.topics.map((topic) => topic.id)).toEqual(['drawing']); expect(result.failed).toBe(HELP_TOPICS.length - 1);
  });
  it('章・見出し・Webリンクを解決し、それ以外のプロトコルや未同梱の章を拒む', () => {
    expect(resolveHelpLink('./drawing.md#断面')).toEqual({ kind: 'topic', id: 'drawing', anchor: '断面' });
    expect(resolveHelpLink('#操作')).toEqual({ kind: 'anchor', anchor: '操作' });
    expect(resolveHelpLink('https://example.com/help')).toEqual({ kind: 'external', href: 'https://example.com/help' });
    for (const href of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,x', '//example.com', '../drawing.md', 'absent.md']) expect(resolveHelpLink(href), href).toBeNull();
  });
});
