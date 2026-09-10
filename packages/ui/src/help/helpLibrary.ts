import { HELP_TOPICS, type HelpTopic } from '@pointercad/help-content';

export type HelpLoader = () => Promise<string>;
export const helpTopic = (id: string): HelpTopic | undefined => HELP_TOPICS.find((topic) => topic.id === id);

/** 章の失敗をキャッシュせず再試行できる。検索時にだけ本文を全件読む。 */
export function createHelpLibrary(loaders: Readonly<Record<string, HelpLoader>>) {
  const cache = new Map<string, Promise<string>>();
  const load = (id: string): Promise<string> => {
    const existing = cache.get(id);
    if (existing !== undefined) return existing;
    const loader = loaders[id];
    if (loader === undefined) return Promise.reject(new Error(`Unknown help topic: ${id}`));
    const pending = Promise.resolve().then(loader).catch((error: unknown) => { cache.delete(id); throw error; });
    cache.set(id, pending);
    return pending;
  };
  return {
    load,
    async search(query: string): Promise<{ readonly topics: readonly HelpTopic[]; readonly failed: number }> {
      const words = query.normalize('NFKC').toLocaleLowerCase('ja').trim().split(/\s+/u).filter(Boolean);
      if (words.length === 0) return { topics: HELP_TOPICS, failed: 0 };
      const loaded = await Promise.allSettled(HELP_TOPICS.map(async (topic) => ({ topic, body: await load(topic.id) })));
      const topics: HelpTopic[] = []; let failed = 0;
      for (const result of loaded) {
        if (result.status === 'rejected') { failed += 1; continue; }
        const text = `${result.value.topic.title}\n${result.value.body}`.normalize('NFKC').toLocaleLowerCase('ja');
        if (words.every((word) => text.includes(word))) topics.push(result.value.topic);
      }
      return { topics, failed };
    },
  };
}

export type HelpLink = { readonly kind: 'topic'; readonly id: string; readonly anchor: string }
  | { readonly kind: 'external'; readonly href: string } | { readonly kind: 'anchor'; readonly anchor: string };

/** 相対Markdownリンクは同梱の目録だけで解決する。HTMLや任意スキームを実行しない。 */
export function resolveHelpLink(href: string): HelpLink | null {
  if (href.startsWith('#')) return { kind: 'anchor', anchor: href.slice(1) };
  if (/^https?:\/\//iu.test(href)) {
    try { const url = new URL(href); return { kind: 'external', href: url.href }; } catch { return null; }
  }
  const match = /^(?:\.\/)?([a-z0-9-]+)\.md(?:#(.*))?$/u.exec(href);
  if (match === null || helpTopic(match[1] ?? '') === undefined) return null;
  return { kind: 'topic', id: match[1] ?? '', anchor: match[2] ?? '' };
}
