/** Check only our rendered HTML attributes; Markdown and untrusted HTML are never parsed here. */
export function validateManualLinks(pages: ReadonlyMap<string, string>, assets: ReadonlySet<string>): void {
  const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#x27;': "'" };
  const decode = (value: string): string => value.replace(/&(?:amp|quot|lt|gt|#x27);/gu, entity => entities[entity] ?? entity);
  const idsByPage = new Map<string, ReadonlySet<string>>();
  for (const [path, html] of pages) {
    const ids = new Set<string>();
    for (const match of html.matchAll(/\sid="([^"]*)"/gu)) {
      const id = decode(match[1]);
      if (ids.has(id)) throw new Error(`Duplicate manual anchor: ${path}#${id}`);
      ids.add(id);
    }
    idsByPage.set(path, ids);
  }
  for (const [path, html] of pages) {
    for (const match of html.matchAll(/\s(?:href|src)="([^"]*)"/gu)) {
      const href = decode(match[1]);
      if (/^https?:\/\//iu.test(href)) continue;
      const target = new URL(href, `https://manual.invalid/${path}`);
      if (target.origin !== 'https://manual.invalid') throw new Error(`Unsafe manual link: ${path}: ${href}`);
      const name = decodeURIComponent(target.pathname.slice(1));
      if (!pages.has(name) && !assets.has(name)) throw new Error(`Missing manual target: ${path}: ${href}`);
      if (target.hash && !idsByPage.get(name)?.has(decodeURIComponent(target.hash.slice(1)))) {
        throw new Error(`Missing manual anchor: ${path}: ${href}`);
      }
    }
  }
}
