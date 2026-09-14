/** Printed cross-volume references remain usable after moving or printing the PDF files. */
import { URL } from 'node:url';

export function createManualPrintLinkResolver(manifest, volumeId) {
  const volumes = new Map(manifest.volumes.map(volume => [volume.id, volume]));
  const chapters = new Map(manifest.chapters.map(chapter => [chapter.id, chapter]));
  if (!volumes.has(volumeId)) throw new Error('Unknown printed volume');
  const reference = (id, anchor = '') => {
    const chapter = chapters.get(id), volume = chapter && volumes.get(chapter.volumeId);
    if (!chapter || !volume) throw new Error('Missing printed chapter: ' + id);
    if (volume.id === volumeId) {
      return { kind: 'anchor', href: '#' + (anchor ? id + '-help-' + anchor : 'chapter-' + id) };
    }
    return { kind: 'reference', text: '（' + volume.title + ' → ' + chapter.title + '）' };
  };
  return href => {
    if (typeof href !== 'string' || href === '') throw new Error('Empty manual reference');
    const base = 'https://manual.invalid/volumes/' + volumeId + '.html';
    const target = new URL(href, base);
    if (target.origin !== 'https://manual.invalid') {
      if (!/^https?:\/\//iu.test(href)) throw new Error('Unsafe manual reference');
      return { kind: 'external', href: target.href };
    }
    if (target.search) throw new Error('Unexpected manual query');
    if (target.pathname === '/volumes/' + volumeId + '.html') {
      if (!target.hash) throw new Error('Missing local chapter anchor');
      return { kind: 'anchor', href: target.hash };
    }
    if (target.pathname === '/index.html') return { kind: 'anchor', href: '#manual-all-volumes' };
    const chapter = /^\/chapters\/([a-z][a-z0-9-]*)\.html$/u.exec(target.pathname);
    if (chapter) {
      const anchor = decodeURIComponent(target.hash.slice(1));
      if (anchor && !anchor.startsWith('help-')) throw new Error('Unknown chapter anchor');
      return reference(chapter[1], anchor ? anchor.slice(5) : '');
    }
    const volume = /^\/volumes\/([a-z][a-z0-9-]*)\.html$/u.exec(target.pathname);
    if (volume && volumes.has(volume[1]) && !target.hash) {
      return { kind: 'reference', text: '（' + volumes.get(volume[1]).title + '）' };
    }
    throw new Error('Unknown manual reference: ' + href);
  };
}
