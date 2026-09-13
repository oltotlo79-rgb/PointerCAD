import { adjacentHelpTopics, MANUAL_CHAPTERS, initialHelpHistory, stepHelpHistory, visitHelp, type HelpTopic } from '@pointercad/help-content';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { HELP_IMAGES, helpLibrary } from './helpContent.js';
import { HelpMarkdown } from './HelpMarkdown.js';
import { HelpTableOfContents } from './HelpTableOfContents.js';

export function HelpDialog({ topicId }: { readonly topicId: string }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null); const article = useRef<HTMLElement>(null);
  const [query, setQuery] = useState(''); const [retry, setRetry] = useState(0);
  const [content, setContent] = useState<{ readonly id: string; readonly body: string | null; readonly failed: boolean } | null>(null);
  const [search, setSearch] = useState<{ readonly query: string; readonly topics: readonly HelpTopic[]; readonly failed: number } | null>(null);
  const pendingAnchor = useRef('');
  const pendingScroll = useRef<number | null>(null);
  const [history, setHistory] = useState(() => initialHelpHistory(topicId));
  if (history.visits[history.index].topicId !== topicId) {
    setHistory(visitHelp(history, { topicId, anchor: '', scrollTop: 0 }, history.visits[history.index].scrollTop));
  }
  const scrollToAnchor = (anchor: string): void => {
    let decoded: string; try { decoded = decodeURIComponent(anchor); } catch { decoded = anchor; }
    const element = Array.from(article.current?.querySelectorAll('[id]') ?? []).find((item) => item.id === `help-${decoded}`);
    if (element !== undefined) element.scrollIntoView({ block: 'start' }); else article.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const element = dialog.current; const previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    void helpLibrary.load(topicId).then((body) => { if (active) setContent({ id: topicId, body, failed: false }); },
      () => { if (active) setContent({ id: topicId, body: null, failed: true }); });
    return () => { active = false; };
  }, [topicId, retry]);
  useEffect(() => {
    if (content?.id !== topicId || content.body === null) return;
    if (pendingScroll.current !== null) article.current?.scrollTo({ top: pendingScroll.current });
    else scrollToAnchor(pendingAnchor.current);
    pendingAnchor.current = ''; pendingScroll.current = null;
  }, [content, topicId]);
  useEffect(() => {
    if (query.trim() === '') return;
    let active = true;
    const timer = setTimeout(() => {
      void helpLibrary.search(query).then((result) => { if (active) setSearch({ query, ...result }); });
    }, 160);
    return () => { active = false; clearTimeout(timer); };
  }, [query, retry]);
  const searching = query.trim() !== '' && search?.query !== query;
  const topics = query.trim() === '' ? MANUAL_CHAPTERS : search?.query === query ? search.topics : [];
  const choose = (id: string, anchor = ''): void => {
    setHistory(visitHelp(history, { topicId: id, anchor, scrollTop: 0 }, article.current?.scrollTop ?? 0));
    pendingScroll.current = null;
    if (id === topicId) { scrollToAnchor(anchor); return; }
    pendingAnchor.current = anchor; useAppStore.getState().openHelpTopic(id);
  };
  const move = (direction: -1 | 1): void => {
    const next = stepHelpHistory(history, direction, article.current?.scrollTop ?? 0);
    if (next === history) return;
    setHistory(next);
    const target = next.visits[next.index];
    if (target.topicId === topicId) { article.current?.scrollTo({ top: target.scrollTop }); return; }
    pendingScroll.current = target.scrollTop; pendingAnchor.current = target.anchor;
    useAppStore.getState().openHelpTopic(target.topicId);
  };
  const { previous: previousChapter, next: nextChapter } = adjacentHelpTopics(MANUAL_CHAPTERS, topicId);
  return <dialog ref={dialog} className="pcad-help" aria-labelledby="pcad-help-title" onCancel={(event) => { event.preventDefault(); useAppStore.getState().closeHelp(); }}
    onKeyDown={(event) => event.stopPropagation()}>
    <header className="pcad-help__header"><h2 id="pcad-help-title">{t('help.title')}</h2>
      <button type="button" onClick={() => choose('help-reader')}>{t('help.howToRead')}</button>
      <nav className="pcad-help__history" aria-label={t('help.history')}>
        <button type="button" disabled={history.index === 0} onClick={() => move(-1)}>{t('help.back')}</button>
        <button type="button" disabled={history.index + 1 === history.visits.length} onClick={() => move(1)}>{t('help.forward')}</button>
      </nav>
      <button className="pcad-button" type="button" title={t('help.close')} onClick={() => useAppStore.getState().closeHelp()}>{t('help.close')}</button></header>
    <div className="pcad-help__body"><nav className="pcad-help__nav" aria-label={t('help.contents')}>
      <label>{t('help.search')}<input type="search" className="pcad-field__input" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {searching ? <p role="status">{t('help.searching')}</p> : null}
      {!searching && topics.length === 0 ? <p role="status">{t('help.noResults')}</p> : null}
      {query.trim() !== '' && search?.query === query && search.failed > 0 ? <p role="alert">{t('help.searchIncomplete')}
        <button type="button" onClick={() => { setSearch(null); setRetry((value) => value + 1); }}>{t('help.retry')}</button></p> : null}
      <HelpTableOfContents topics={topics} topicId={topicId} searching={query.trim() !== ''} onChoose={choose} />
    </nav><article ref={article} className="pcad-help__article" aria-label={t('help.article')} tabIndex={0}>
      {content?.id !== topicId ? <p role="status">{t('help.loading')}</p> : content.failed ? <p role="alert">{t('help.loadFailed')}
        <button type="button" onClick={() => { setContent(null); setRetry((value) => value + 1); }}>{t('help.retry')}</button></p>
        : <HelpMarkdown source={content.body ?? ''} onTopic={choose} onAnchor={anchor => choose(topicId, anchor)} images={HELP_IMAGES} />}
      <nav className="pcad-help__adjacent" aria-label={t('help.chapters')}>
        {previousChapter ? <button type="button" onClick={() => choose(previousChapter.id)}>{t('help.previousChapter')}: {previousChapter.title}</button> : <span />}
        {nextChapter ? <button type="button" onClick={() => choose(nextChapter.id)}>{t('help.nextChapter')}: {nextChapter.title}</button> : null}
      </nav>
    </article></div>
  </dialog>;
}
