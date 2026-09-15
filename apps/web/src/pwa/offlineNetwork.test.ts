import { describe, expect, it } from 'vitest';
import { offlineAssetRequestUrl } from './offlineNetwork.js';

describe('公開先のHTMLルートを決め、元の資産名と混同しない', () => {
  it.each([
    ['index.html', '/'], ['manual/index.html', '/manual/'],
    ['manual/chapters/sketch.html', '/manual/chapters/sketch'],
    ['assets/app.js', '/assets/app.js'], ['manual/manual.css', '/manual/manual.css'],
    ['manual/volumes/sketch.pdf', '/manual/volumes/sketch.pdf'],
    ['images/example.html.png', '/images/example.html.png'], ['offline-assets.json', '/offline-assets.json'],
  ])('%sの内容を既知の公開URL%sから取得する', (path, expected) => {
    expect(offlineAssetRequestUrl(new URL('https://pointercad.test/'), path).href).toBe(`https://pointercad.test${expected}`);
  });
  it.each(['../outside.js', '/outside.js', '%2e%2e/outside.js', 'https://other.test/app.js',
    'file.js?revision=1', 'file.js#other', 'file%2Fpart.js', '%ff'])('不正な資産名%sを取得先にしない', path => {
    expect(() => offlineAssetRequestUrl(new URL('https://pointercad.test/'), path)).toThrow();
  });
});
