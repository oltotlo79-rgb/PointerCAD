import { createHelpSearchIndex, type HelpSearchDocument } from '@pointercad/help-content';

interface ManualSearchData { readonly documents: readonly HelpSearchDocument[]; readonly empty: string; readonly count: string }
export function parseManualSearchData(source: string): ManualSearchData {
  const data: unknown = JSON.parse(source);
  if (data === null || typeof data !== 'object' || !('documents' in data) || !Array.isArray(data.documents)
    || !('empty' in data) || typeof data.empty !== 'string' || !('count' in data) || typeof data.count !== 'string') throw new Error('Invalid manual search data');
  const documents = data.documents.map((document: unknown): HelpSearchDocument => {
    if (document === null || typeof document !== 'object' || !('id' in document) || typeof document.id !== 'string'
      || !/^[a-z][a-z0-9-]*$/u.test(document.id) || !('title' in document) || typeof document.title !== 'string'
      || !('body' in document) || typeof document.body !== 'string') throw new Error('Invalid manual search chapter');
    return { id: document.id, title: document.title, body: document.body };
  });
  return { documents, empty: data.empty, count: data.count };
}

/** No network, storage, innerHTML or evaluation; this also works from an extracted local manual. */
export function attachManualSearch(document: Document): () => void {
  const dataNode = document.getElementById('manual-search-data'), input = document.getElementById('manual-query');
  const results = document.getElementById('manual-search-results'), status = document.getElementById('manual-search-status');
  if (!dataNode || !(input instanceof HTMLInputElement) || !results || !status) throw new Error('Manual search controls are missing');
  const data = parseManualSearchData(dataNode.textContent ?? ''), index = createHelpSearchIndex(data.documents);
  const byId = new Map(data.documents.map(chapter => [chapter.id, chapter]));
  const update = (): void => {
    const hits = input.value.trim() === '' ? [] : index.search(input.value);
    results.replaceChildren(...hits.map(hit => {
      const item = document.createElement('li'), link = document.createElement('a');
      link.href = `chapters/${hit.id}.html`; link.textContent = byId.get(hit.id)?.title ?? hit.id;
      item.append(link); return item;
    }));
    status.textContent = input.value.trim() === '' ? '' : hits.length === 0 ? data.empty : data.count.replace('{count}', String(hits.length));
  };
  const escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.isComposing) { input.value = ''; update(); }
  };
  input.addEventListener('input', update); input.addEventListener('keydown', escape);
  return () => { input.removeEventListener('input', update); input.removeEventListener('keydown', escape); };
}
