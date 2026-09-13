import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HELP_TOPICS, MANUAL_CHAPTERS, MANUAL_VOLUMES, createHelpSearchIndex } from '@pointercad/help-content';
import { buildManualPages } from './manualPages.js';
import { parseManualSearchData } from './manualSearch.js';
import { validateManualLinks } from './manualLinks.js';
import { createHelpLibrary } from './helpLibrary.js';
import { HELP_LOADERS } from './helpContent.js';
import { ja } from '../i18n/ja.js';

const sources = new Map(MANUAL_CHAPTERS.map(chapter => [chapter.id, readFileSync(new URL(`../../../help-content/${chapter.path}`, import.meta.url), 'utf8')]));
const imageEntries = [...sources.values()].flatMap(source => [...source.matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/gu)]
  .map(match => [match[1], `../${match[1].replace(/^\.\//u, '')}`] as const));
const images = Object.fromEntries(imageEntries);
describe('全巻の取扱説明書とローカル索引', () => {
  it('全98章・7巻・索引が揃い、検索も同じ本文を参照する', () => {
    const pages = buildManualPages(sources, images);
    expect(pages.size).toBe(MANUAL_CHAPTERS.length + MANUAL_VOLUMES.length + 1);
    const index = pages.get('index.html') ?? '';
    expect(index).toContain(`<title>${ja['help.manualTitle']}</title>`);
    const payload = /<script id="manual-search-data" type="application\/json">(.*?)<\/script>/su.exec(index)?.[1];
    if (!payload) throw new Error('Manual search data is missing');
    const data = parseManualSearchData(payload);
    expect(data.documents.map(chapter => chapter.id)).toEqual(HELP_TOPICS.map(chapter => chapter.id));
    expect(createHelpSearchIndex(data.documents).search('フランジ').some(hit => hit.id === 'sheet-metal-flange')).toBe(true);
    for (const chapter of MANUAL_CHAPTERS) {
      expect(pages.get(`chapters/${chapter.id}.html`)).toContain(`../volumes/${chapter.volumeId}.html#chapter-${chapter.id}`);
      expect(pages.get(`volumes/${chapter.volumeId}.html`)).toContain(`id="chapter-${chapter.id}"`);
    }
    validateManualLinks(pages, new Set([...pages.keys(), 'manual.css', 'manualSearch.js',
      ...Object.values(images).map(path => path.replace(/^\.\.\//u, ''))]));
  });
  it('アプリのF1と説明書は同点の候補も含め検索結果の順序が一致する', async () => {
    const index = buildManualPages(sources, images).get('index.html') ?? '';
    const payload = /<script id="manual-search-data" type="application\/json">(.*?)<\/script>/su.exec(index)?.[1];
    if (!payload) throw new Error('Manual search data is missing');
    const manual = createHelpSearchIndex(parseManualSearchData(payload).documents), application = createHelpLibrary(HELP_LOADERS);
    for (const query of ['フランジ', '座標 式', 'ラジアン', '干渉', '関数', '点', '線', '保存']) {
      const result = await application.search(query);
      expect(result.failed).toBe(0);
      expect(manual.search(query).map(hit => hit.id), query).toEqual(result.topics.map(topic => topic.id));
    }
  });
  it('欠けた章や画像、危険な検索先を黙って除外しない', () => {
    const missing = new Map(sources); missing.delete(MANUAL_CHAPTERS[0].id);
    expect(() => buildManualPages(missing, images)).toThrow('count');
    const wrongTitle = new Map(sources); wrongTitle.set(MANUAL_CHAPTERS[0].id, '# 古い画面名');
    expect(() => buildManualPages(wrongTitle, images)).toThrow('title');
    expect(() => buildManualPages(sources, {})).toThrow('image');
    expect(() => parseManualSearchData(JSON.stringify({ empty: '', count: '', documents: [{ id: '../escape', title: '', body: '' }] }))).toThrow('chapter');
  });
  it('本文のscript終端で埋込検索データを抜け出せない', () => {
    const unsafe = new Map(sources); unsafe.set(MANUAL_CHAPTERS[0].id, `# ${MANUAL_CHAPTERS[0].title}\n\n</script><script>alert(1)</script>`);
    const index = buildManualPages(unsafe, images).get('index.html') ?? '';
    expect(index).not.toContain('<script>alert(1)');
    expect(index).toContain('\\u003c/script\\u003e');
  });
});
