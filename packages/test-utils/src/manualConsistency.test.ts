import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyManualConsistency, type ExpectedManualEdition } from '../../../scripts/manual/manualConsistency.mjs';

const bytes = (value: string) => new TextEncoder().encode(value);
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const expected: ExpectedManualEdition = {
    chapters: [{ id: 'points', title: '座標', volumeId: 'sketch', order: 0 }, { id: 'solid', title: '立体', volumeId: 'solid', order: 1 }],
    volumes: [{ id: 'sketch', title: 'スケッチ', topics: ['points'] }, { id: 'solid', title: '立体', topics: ['solid'] }],
    featureCoverage: { entries: [{ id: 'FR-201', topicIds: ['points'] }], pending: [], contentCertified: false },
    commandCoverage: [{ commandId: 'point', topicId: 'points', chapterPath: 'docs/ja/points.md' }],
    supplementaryCoverage: { settings: [{ id: 'theme', topicIds: ['points'] }], contentCertified: false },
    nativeControlCoverage: { scope: 'native-jsx-controls', controls: [{ name: '決定', description: '点を置きます' }], contentCertified: false },
    pages: new Map([['index.html', '<h1>全巻</h1>'], ['chapters/points.html', '<h1>座標</h1><p>決定を押す</p>'],
      ['chapters/solid.html', '<h1>立体</h1>'], ['volumes/sketch.html', '<h1>座標</h1>'], ['volumes/solid.html', '<h1>立体</h1>']]),
    images: new Map([['images/point.png', bytes('actual fixture screenshot bytes')]]),
  };
  const metadata = { chapters: expected.chapters, volumes: expected.volumes, featureCoverage: expected.featureCoverage,
    commandCoverage: expected.commandCoverage, supplementaryCoverage: expected.supplementaryCoverage,
    nativeControlCoverage: expected.nativeControlCoverage };
  const manifest = { format: 'pointercad-manual/1', releaseCertified: false, ...metadata,
    inputs: { 'packages/help-content/docs/ja/points.md': hash('# 座標') },
    images: { 'images/point.png': { sha256: hash('actual fixture screenshot bytes'), captureCertified: false } },
    outputs: {}, buildId: '' };
  const coverage = { format: 'pointercad-help-coverage/1', features: expected.featureCoverage,
    commands: expected.commandCoverage, supplementary: expected.supplementaryCoverage,
    nativeControls: expected.nativeControlCoverage, releaseCertified: false };
  const files = new Map<string, Uint8Array>([...expected.pages].map(([name, text]) => [name, bytes(text)]));
  for (const [name, content] of expected.images) files.set(name, content);
  files.set('manual.css', bytes('body { color: black; }'));
  files.set('feature-coverage.json', bytes(JSON.stringify(coverage)));
  const seal = () => {
    manifest.outputs = Object.fromEntries([...files].filter(([name]) => name !== 'manifest.json').map(([name, content]) => [name, hash(content)]));
    manifest.buildId = hash(JSON.stringify({ inputs: manifest.inputs, outputs: manifest.outputs }));
    files.set('manifest.json', bytes(JSON.stringify(manifest)));
  };
  seal();
  return { expected, manifest, files, coverage, seal,
    verify: () => verifyManualConsistency([...files].map(([path, content]) => ({ path, bytes: content })), expected) };
}

describe('配布へ入れる説明書を現在のヘルプと照合する', () => {
  it('本文・操作名・全章・全巻・画像・機能対応が一致しても公開認定には代用しない', () => {
    const f = fixture();
    expect(f.verify()).toEqual({ manualBuildId: f.manifest.buildId, chapters: 2, images: 1,
      contentMatchesCurrentHelp: true, releaseCertified: false });
  });
  it.each(['chapters/points.html', 'volumes/sketch.html', 'index.html'])('出力側の記録も作り直した古い本文を拒否する: %s', name => {
    const f = fixture(); f.files.set(name, bytes('<p>廃止したボタンを押す</p>')); f.seal();
    expect(f.verify).toThrow('text or controls');
  });
  it('記録からも消した章と、目録にない余分な章を拒否する', () => {
    const f = fixture(); f.files.delete('chapters/points.html'); f.seal(); expect(f.verify).toThrow('HTML pages');
    const g = fixture(); g.files.set('chapters/extra.html', bytes('extra')); g.seal(); expect(g.verify).toThrow('HTML pages');
  });
  it.each(['chapters', 'volumes', 'featureCoverage', 'commandCoverage', 'supplementaryCoverage', 'nativeControlCoverage'] as const)(
    '現在の正本と異なる対応情報を拒否する: %s', key => {
      const f = fixture();
      f.files.set('manifest.json', bytes(JSON.stringify({ ...f.manifest, [key]: [] })));
      expect(f.verify).toThrow('current help: ' + key);
    });
  it('題名だけの差し替え、機能の取りこぼし、操作の別章への割当も拒否する', () => {
    for (const replacement of [
      { chapters: [{ id: 'points', title: '別の題名', volumeId: 'sketch', order: 0 },
        { id: 'solid', title: '立体', volumeId: 'solid', order: 1 }] },
      { featureCoverage: { entries: [], pending: [], contentCertified: true } },
      { commandCoverage: [{ commandId: 'point', topicId: 'solid', chapterPath: 'docs/ja/solid.md' }] },
    ]) {
      const f = fixture(); f.files.set('manifest.json', bytes(JSON.stringify({ ...f.manifest, ...replacement })));
      expect(f.verify).toThrow('current help');
    }
  });
  it('画像とその指紋を一緒に差し替えても現在の実画像と違えば拒否する', () => {
    const f = fixture(); f.files.set('images/point.png', bytes('old screenshot'));
    f.manifest.images['images/point.png'].sha256 = hash('old screenshot'); f.seal();
    expect(f.verify).toThrow('Manual image changed');
  });
  it('画像一覧の欠落と、本文から参照されない画像の追加を拒否する', () => {
    const f = fixture(); f.files.delete('images/point.png'); f.seal(); expect(f.verify).toThrow('Manual images');
    const g = fixture(); g.files.set('images/extra.png', bytes('extra')); g.seal(); expect(g.verify).toThrow('Manual images');
  });
  it('別ファイルの対応一覧だけを書き換えて取りこぼしを隠せない', () => {
    const f = fixture(); f.files.set('feature-coverage.json', bytes(JSON.stringify({ ...f.coverage, commands: [] }))); f.seal();
    expect(f.verify).toThrow('feature coverage');
  });
  it('自己申告した指紋との不一致も引き続き拒否する', () => {
    const f = fixture(); f.files.set('manual.css', bytes('wrong')); expect(f.verify).toThrow('Manual output changed');
    const g = fixture(); g.files.set('manifest.json', bytes(JSON.stringify({ ...g.manifest, buildId: '0'.repeat(64) })));
    expect(g.verify).toThrow('identity');
  });
  it('JSONのキー順の変更で同じ内容を誤って拒否しない', () => {
    const f = fixture();
    f.files.set('manifest.json', bytes(JSON.stringify(Object.fromEntries(Object.entries(f.manifest).reverse()))));
    expect(f.verify().contentMatchesCurrentHelp).toBe(true);
  });
  it('重複ファイルと上位フォルダーを指すファイル名を拒否する', () => {
    const f = fixture(), files = [...f.files].map(([path, content]) => ({ path, bytes: content }));
    expect(() => verifyManualConsistency([...files, files[0]], f.expected)).toThrow('Duplicate');
    expect(() => verifyManualConsistency([...files, { path: '../outside.html', bytes: bytes('x') }], f.expected)).toThrow();
  });
});
