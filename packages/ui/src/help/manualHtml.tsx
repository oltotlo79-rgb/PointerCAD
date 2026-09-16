import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveHelpUiReferences, type ManualChapter } from '@pointercad/help-content';
import { ja } from '../i18n/ja.js';
import { HelpMarkdown } from './HelpMarkdown.js';
import { resolveShortcutTable } from '../commands/shortcutMarkdown.js';

/** Reuse the live reader for export. No second Markdown parser or UI-label dictionary. */
export function renderManualChapter(chapter: ManualChapter, markdown: string, images: Readonly<Record<string, string>>,
  options: { readonly combined?: boolean; readonly topicHref?: (id: string, anchor: string) => string } = {}): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(chapter.id)) throw new Error('Invalid manual chapter id');
  const headingPrefix = options.combined ? `${chapter.id}-help-` : 'help-';
  return renderToStaticMarkup(createElement('article', { id: `chapter-${chapter.id}`, lang: 'ja' },
    createElement(HelpMarkdown, { source: resolveShortcutTable(resolveHelpUiReferences(markdown, ja)), images, headingPrefix,
      onTopic: () => undefined, onAnchor: () => undefined,
      topicHref: options.topicHref ?? ((id, anchor) => `../chapters/${encodeURIComponent(id)}.html${anchor ? `#help-${anchor}` : ''}`) })));
}
