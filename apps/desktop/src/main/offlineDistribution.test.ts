import { bytes, json, fixture } from './distributionTestFixture.js';
import { describe, expect, it } from 'vitest';
import { readOfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';

describe('同じ版の本体・説明書・全PDF巻を揃えてから通信なしの一式を作る', () => {
  it('全出力を指紋一覧へ含め、HTMLの版とPDF全巻の対応を保つ', async () => {
    const f = fixture(), result = f.assemble();
    expect(result.pdfVolumes).toBe(2); expect(result.releaseCertified).toBe(false);
    expect(result.files.get('manual/pdf/second.pdf')).toEqual(f.pdf.get('second.pdf'));
    expect(result.files.get('manual/chapters/first.html')).toEqual(f.manual.get('chapters/first.html'));
    const manifest = await readOfflineAssetManifest(JSON.parse(new TextDecoder().decode(result.files.get('offline-assets.json'))));
    expect(manifest.required).toEqual(manifest.assets.map(asset => asset.url));
    expect(manifest.assets.some(asset => asset.url === 'service-worker.js')).toBe(false);
    expect(result.files.has('service-worker.js')).toBe(true); expect(result.files.has('_headers')).toBe(true);
  });
  it.each(['index.html', 'service-worker.js', '_headers', 'web-build.json'])('本体の必要な出力%sの欠落を拒否する', name => {
    const f = fixture(); f.web.delete(name); expect(f.assemble).toThrow();
  });
  it('同じ名前の本体が別の内容に替わると拒否する', () => {
    const f = fixture(); f.web.set('index.html', bytes('other')); expect(f.assemble).toThrow('Web output changed');
  });
  it('説明書の1章やPDFの1巻が欠けた場合を拒否する', () => {
    const f = fixture(); f.manual.delete('chapters/first.html'); expect(f.assemble).toThrow('Manual output changed');
    const g = fixture(); g.pdf.delete('second.pdf'); expect(g.assemble).toThrow();
  });
  it('新しいHTMLへ古いPDFを組み合わせることと、PDF生成途中を拒否する', () => {
    const f = fixture(); f.pdfManifest.manualBuildId = 'a'.repeat(64); f.pdf.set('pdf-manifest.json', json(f.pdfManifest));
    expect(f.assemble).toThrow('PDF and HTML editions differ');
    const g = fixture(); g.pdfManifest.completed = false; g.pdf.set('pdf-manifest.json', json(g.pdfManifest));
    expect(g.assemble).toThrow('PDF and HTML editions differ');
  });
  it('PDFの順番・章の欠落・未確認の余分な出力で全巻を揃えたことにしない', () => {
    const f = fixture(); f.pdfManifest.volumes.reverse(); f.pdf.set('pdf-manifest.json', json(f.pdfManifest));
    expect(f.assemble).toThrow('Missing, reordered or changed PDF volume');
    const g = fixture(); g.pdfManifest.volumes[0].content.chapters = []; g.pdf.set('pdf-manifest.json', json(g.pdfManifest));
    expect(g.assemble).toThrow('Missing, reordered or changed PDF volume');
    const h = fixture(); h.pdf.set('unexpected.pdf', bytes('extra')); expect(h.assemble).toThrow('Unexpected PDF output');
  });
  it('準備済みの一覧や説明書を含む本体へ重ねて作らない', () => {
    const f = fixture(); f.web.set('offline-assets.json', bytes('{}')); expect(f.assemble).toThrow('earlier offline inventory');
    const g = fixture(); g.web.set('manual/index.html', bytes('old manual')); expect(g.assemble).toThrow();
  });
});
