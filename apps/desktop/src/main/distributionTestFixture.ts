import { createHash } from 'node:crypto';
import { assembleOfflineDistribution } from '../../../../scripts/vite/offlineDistribution.mjs';

export const bytes = (value: string) => new TextEncoder().encode(value);
export const json = (value: unknown) => bytes(JSON.stringify(value));
export const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export const inputs = { 'packages/ui/src/example.ts': hash('source') };
export const files = (map: ReadonlyMap<string, Uint8Array>) => [...map].map(([path, bytes]) => ({ path, bytes }));
export function fixture() {
  const web = new Map([['index.html', bytes('app')], ['service-worker.js', bytes('worker')], ['_headers', bytes('headers')]]);
  web.set('web-build.json', json({ format: 'pointercad-web-build/1', inputs, outputs: Object.fromEntries([...web].map(([name, value]) => [name, hash(value)])) }));
  const manual = new Map([['index.html', bytes('index')], ['fonts/LICENSES.txt', bytes('notice')]]);
  const chapters = ['first', 'second'].map(id => ({ id, title: id }));
  const volumes = chapters.map(chapter => ({ id: chapter.id, title: chapter.title, topics: [chapter.id] }));
  for (const chapter of chapters) {
    manual.set('chapters/' + chapter.id + '.html', bytes(chapter.id));
    manual.set('volumes/' + chapter.id + '.html', bytes(chapter.id));
  }
  const outputs = Object.fromEntries([...manual].map(([name, value]) => [name, hash(value)]));
  const buildId = hash(JSON.stringify({ inputs, outputs }));
  const manualManifest = { format: 'pointercad-manual/1', inputs, outputs, buildId, chapters, volumes };
  const manualBytes = json(manualManifest); manual.set('manifest.json', manualBytes);
  const pdf = new Map([['LICENSES.txt', bytes('notice')], ...chapters.map(chapter => [chapter.id + '.pdf', bytes('%PDF-' + chapter.id)] as const)]);
  const pdfManifest = { format: 'pointercad-manual-pdf/1', completed: true, manualBuildId: buildId,
    manualManifestSha256: hash(manualBytes), fontNoticeSha256: hash('notice'), volumes: volumes.map(volume => {
      const value = pdf.get(volume.id + '.pdf'); if (value === undefined) throw new Error('Missing fixture PDF');
      return { id: volume.id, name: volume.id + '.pdf', title: volume.title, source: 'volumes/' + volume.id + '.html',
        bytes: value.byteLength, sha256: hash(value), content: { chapters: ['chapter-' + volume.id] } };
    }) };
  pdf.set('pdf-manifest.json', json(pdfManifest));
  return { web, manual, pdf, manualManifest, pdfManifest,
    assemble: () => assembleOfflineDistribution(files(web), files(manual), files(pdf)) };
}
