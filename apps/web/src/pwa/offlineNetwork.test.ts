import { describe, expect, it } from 'vitest';
import { offlineAssetRequestUrl, readBoundedOfflineBody } from './offlineNetwork.js';

describe('公開先のHTMLルートを決め、元の資産名と混同しない', () => {
  it('虚偽の巨大Content-Lengthを使わず、受信したchunkだけを連結する', async () => {
    const values: number[] = [];
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close();
    } }), { headers: { 'Content-Length': String(Number.MAX_SAFE_INTEGER) } });
    const result = await readBoundedOfflineBody(response, 67_108_864, 'stream.wasm',
      new AbortController().signal, count => { values.push(count); });
    expect([...result]).toEqual([1, 2, 3]);
    expect(values).toEqual([2, 3]);
  });
  it('復号上限を越えたchunkをEOF待ちせず拒否する', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    } }));
    await expect(readBoundedOfflineBody(response, 3, 'stream.wasm', new AbortController().signal,
      () => undefined)).rejects.toMatchObject({ reason: 'size' });
  });
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
