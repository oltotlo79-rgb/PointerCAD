/** The same local full-text index is used by application help and the exported manual. */
export interface HelpSearchDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly keywords?: readonly string[];
}

export interface HelpSearchHit {
  readonly id: string;
  readonly score: number;
}

export function normalizeHelpSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja')
    .replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .replace(/\s+/gu, ' ').trim();
}

export function createHelpSearchIndex(documents: readonly HelpSearchDocument[]) {
  const ids = new Set<string>();
  const entries = documents.map((document, order) => {
    if (ids.has(document.id)) throw new Error(`Duplicate help search topic: ${document.id}`);
    ids.add(document.id);
    return { id: document.id, order, title: normalizeHelpSearch(document.title),
      keywords: normalizeHelpSearch((document.keywords ?? []).join(' ')), body: normalizeHelpSearch(document.body) };
  });
  return {
    search(query: string): readonly HelpSearchHit[] {
      const phrase = normalizeHelpSearch(query);
      const words = [...new Set(phrase.split(' ').filter(Boolean))];
      if (words.length === 0) return entries.map(entry => ({ id: entry.id, score: 0 }));
      const ranked = [];
      for (const entry of entries) {
        const fields = [entry.title, entry.keywords, entry.body];
        if (!words.every(word => fields.some(field => field.includes(word)))) continue;
        let score = entry.title === phrase ? 1000 : entry.title.startsWith(phrase) ? 500 : entry.title.includes(phrase) ? 250 : 0;
        for (const word of words) score += entry.title.includes(word) ? 100 : entry.keywords.includes(word) ? 30 : 1;
        if (entry.body.includes(phrase)) score += 5;
        ranked.push({ id: entry.id, score, order: entry.order });
      }
      ranked.sort((a, b) => b.score - a.score || a.order - b.order);
      return ranked.map(({ id, score }) => ({ id, score }));
    },
  };
}
