import { renderToStaticMarkup } from 'react-dom/server';
import { HELP_TOPICS, MANUAL_CHAPTERS, MANUAL_VOLUMES, resolveHelpUiReferences, type HelpSearchDocument } from '@pointercad/help-content';
import { ja } from '../i18n/ja.js';
import { renderManualChapter } from './manualHtml.js';
import { resolveShortcutTable } from '../commands/shortcutMarkdown.js';

function page(title: string, body: string, root: string, data = ''): string {
  const windowTitle = title === ja['help.manualTitle'] ? title : `${title} — ${ja['help.manualTitle']}`;
  const head = renderToStaticMarkup(<head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta httpEquiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'" />
    <title>{windowTitle}</title><link rel="stylesheet" href={`${root}manual.css`} /></head>);
  const header = renderToStaticMarkup(<header><a href={`${root}index.html`}>{ja['help.manualTitle']}</a>
    <nav aria-label={ja['help.manualIndex']}><a href={`${root}index.html#manual-search`}>{ja['help.manualIndex']}</a></nav></header>);
  return `<!doctype html><html lang="ja">${head}<body>${header}<main id="main">${body}</main>${data}</body></html>`;
}

/** All pages are generated from the same catalog, renderer, UI dictionary and complete chapter sources. */
export function buildManualPages(sources: ReadonlyMap<string, string>, images: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  const files = new Map<string, string>(), search: HelpSearchDocument[] = [];
  if (sources.size !== MANUAL_CHAPTERS.length) throw new Error('Manual source count differs from the help catalog');
  for (const chapter of MANUAL_CHAPTERS) {
    const markdown = sources.get(chapter.id);
    if (markdown === undefined || markdown.trim() === '') throw new Error(`Missing manual source: ${chapter.id}`);
    const title = /^#\s+([^\r\n]+)\s*$/mu.exec(markdown)?.[1].trim();
    if (title !== chapter.title) throw new Error(`Manual title differs from help catalog: ${chapter.id}`);
    for (const image of markdown.matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/gu)) {
      if (!Object.hasOwn(images, image[1])) throw new Error(`Missing manual image in ${chapter.id}: ${image[1]}`);
    }
    search.push({ id: chapter.id, title: chapter.title, body: resolveShortcutTable(resolveHelpUiReferences(markdown, ja)) });
    const previous = MANUAL_CHAPTERS[chapter.order - 1], next = MANUAL_CHAPTERS[chapter.order + 1];
    const navigation = renderToStaticMarkup(<nav className="manual-chapters" aria-label={ja['help.chapters']}>
      {previous && <a rel="prev" href={`${previous.id}.html`}>{ja['help.previousChapter']}: {previous.title}</a>}
      <a href={`../volumes/${chapter.volumeId}.html#chapter-${chapter.id}`}>{ja['help.manualVolume']}</a>
      {next && <a rel="next" href={`${next.id}.html`}>{ja['help.nextChapter']}: {next.title}</a>}
    </nav>);
    files.set(`chapters/${chapter.id}.html`, page(chapter.title, renderManualChapter(chapter, markdown, images) + navigation, '../'));
  }
  for (const volume of MANUAL_VOLUMES) {
    const chapters = MANUAL_CHAPTERS.filter(chapter => chapter.volumeId === volume.id);
    const contents = renderToStaticMarkup(<section className="manual-volume-intro"><h1>{volume.title}</h1>
      <p><a href="../index.html">{ja['help.manualIndex']}</a></p>
      <nav aria-label={volume.title}><ol>{chapters.map(chapter => <li key={chapter.id}><a href={`#chapter-${chapter.id}`}>{chapter.title}</a></li>)}</ol></nav></section>);
    const ids = new Set(chapters.map(chapter => chapter.id));
    const body = chapters.map(chapter => renderManualChapter(chapter, sources.get(chapter.id) ?? '', images, { combined: true,
      topicHref: (id, anchor) => ids.has(id) ? anchor ? `#${id}-help-${anchor}` : `#chapter-${id}`
        : `../chapters/${encodeURIComponent(id)}.html${anchor ? `#help-${anchor}` : ''}`,
    })).join('\n');
    files.set(`volumes/${volume.id}.html`, page(volume.title, contents + body, '../'));
  }
  const index = renderToStaticMarkup(<><h1>{ja['help.manualTitle']}</h1>
    <section id="manual-search" aria-label={ja['help.manualSearch']}>
      <label htmlFor="manual-query">{ja['help.manualSearch']}</label><input id="manual-query" type="search" aria-describedby="manual-search-hint" />
      <p id="manual-search-hint">{ja['help.manualSearchHint']}</p><p id="manual-search-status" role="status" aria-live="polite" />
      <ol id="manual-search-results" aria-label={ja['help.manualSearchResults']} />
    </section>
    <nav aria-label={ja['help.manualIndex']}>{MANUAL_VOLUMES.map(volume => <section key={volume.id}>
      <h2><a href={`volumes/${volume.id}.html`}>{volume.title}</a></h2><ol>{MANUAL_CHAPTERS.filter(chapter => chapter.volumeId === volume.id)
        .map(chapter => <li key={chapter.id}><a href={`chapters/${chapter.id}.html`}>{chapter.title}</a></li>)}</ol></section>)}</nav>
    <p>{ja['help.manualPrint']}</p></>);
  // The shared search ranks equal matches by source order. Keep that order identical to F1,
  // while the printed chapter order remains the order of the seven volumes.
  const searchById = new Map(search.map(document => [document.id, document]));
  const documents = HELP_TOPICS.map(topic => {
    const document = searchById.get(topic.id);
    if (!document) throw new Error(`Missing manual search chapter: ${topic.id}`);
    return document;
  });
  const payload = JSON.stringify({ documents, empty: ja['help.noResults'], count: ja['help.manualSearchCount'] })
    .replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026');
  files.set('index.html', page(ja['help.manualTitle'], index, '',
    `<script id="manual-search-data" type="application/json">${payload}</script><script src="manualSearch.js" defer></script>`));
  return files;
}
