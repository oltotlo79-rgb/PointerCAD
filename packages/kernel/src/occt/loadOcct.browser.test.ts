import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileVerifiedOcctResponse } from './compiledOcctModule.js';
import { fetchVerifiedOcctForBroker, loadLegacyOcct, loadManifestOcct, loadOcctForBrowser, type OcctModuleOptions } from './loadOcct.browser.js';
import type { OcctAssetManifest } from './occtAssetManifest.js';
import { desktopOcctTransportUrl } from './desktopOcctTransportContract.js';

// Native WASM: answer() = 42.
const wasm = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, 42, 11,
]);
const manifestUrl = 'https://pointercad.example/occt/manifest.json';
const assetUrl = 'https://pointercad.example/occt/native.bin';
it('shares an in-flight browser load but releases its rejection for the next explicit call', async () => {
  const refuse = (): Promise<WebAssembly.Module> => Promise.reject(new Error('unavailable module offer'));
  const first = loadOcctForBrowser(refuse);
  expect(loadOcctForBrowser(refuse)).toBe(first);
  await expect(first).rejects.toBeDefined();
  const retry = loadOcctForBrowser(refuse);
  expect(retry).not.toBe(first);
  expect(loadOcctForBrowser(refuse)).toBe(retry);
  await expect(retry).rejects.toBeDefined();
  // This verifies cache lifetime only, not native instantiation; broker tests verify real WASM bytes.
});
const streamUrl = `https://pointercad.example/occt/stream/opencascade.full-${sha256(wasm)}.wasm`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest(bytes: Uint8Array = wasm, compressedLength = 1): OcctAssetManifest {
  return {
    compression: 'gzip',
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    parts: [{ order: 0, file: 'native.bin', byteLength: compressedLength }],
  };
}

function streamingManifest(bytes: Uint8Array = wasm): OcctAssetManifest {
  const compressed = gzipSync(bytes);
  const legacy = manifest(bytes, compressed.byteLength);
  return {
    ...legacy,
    stream: {
      file: `stream/opencascade.full-${legacy.sha256}.wasm`,
      compression: 'gzip',
      transportByteLength: compressed.byteLength,
      transportSha256: sha256(compressed),
      decodedByteLength: bytes.byteLength,
      decodedSha256: legacy.sha256,
    },
  };
}

function asset(bytes: Uint8Array, headers: HeadersInit, status = 200, url = assetUrl): Response {
  // Node Buffer#slice may expose its larger slab via .buffer; copy exact bytes.
  const response = new Response(Uint8Array.from(bytes).buffer, { headers, status });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function result(instance: WebAssembly.Instance): unknown {
  const exported = instance.exports.answer;
  if (typeof exported !== 'function') throw new Error('native fixture lost answer');
  return Reflect.apply(exported, undefined, []);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('browser OCCT loader paths', () => {
  it('prepares the no-argument desktop transport then verifies the genuine decoded HTTP response', async () => {
    const identity = { sha256: sha256(wasm), byteLength: wasm.byteLength };
    const url = desktopOcctTransportUrl(identity.sha256);
    vi.stubGlobal('location', new URL('app://pointercad/index.html'));
    vi.stubGlobal('__PCAD_DESKTOP_OCCT_IDENTITY__', identity);
    const order: string[] = [];
    const prepare = vi.fn(() => { order.push('prepare'); return Promise.resolve({ kind: 'http', url, ...identity }); });
    vi.stubGlobal('window', { pointercadDesktop: { prepareOcctTransport: prepare } });
    const fetchMock = vi.fn(() => { order.push('fetch'); return Promise.resolve(asset(wasm,
      { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' }, 200, url)); });
    vi.stubGlobal('fetch', fetchMock);
    const verified = await fetchVerifiedOcctForBroker();
    if (verified === undefined) throw new Error('missing desktop HTTP verification');
    expect(result(await WebAssembly.instantiate(await compileVerifiedOcctResponse(verified)))).toBe(42);
    expect(order).toEqual(['prepare', 'fetch']);
    expect(prepare).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains the verified app path only for explicit port conflict', async () => {
    const direct = 'app://pointercad/assets/opencascade.full-fixture.wasm';
    vi.stubGlobal('location', new URL('app://pointercad/index.html'));
    vi.stubGlobal('__PCAD_DESKTOP_OCCT_IDENTITY__', { sha256: sha256(wasm), byteLength: wasm.byteLength });
    vi.stubGlobal('window', { pointercadDesktop: { prepareOcctTransport: () => Promise.resolve({ kind: 'direct', reason: 'port-unavailable' }) } });
    const fetchMock = vi.fn((input: string | URL) => {
      expect(String(input)).toBe(direct);
      return Promise.resolve(asset(wasm, { 'Content-Type': 'application/wasm' }, 200, direct));
    });
    vi.stubGlobal('fetch', fetchMock);
    const verified = await fetchVerifiedOcctForBroker(undefined, direct);
    if (verified === undefined) throw new Error('missing verified conflict fallback');
    expect(result(await WebAssembly.instantiate(await compileVerifiedOcctResponse(verified)))).toBe(42);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(direct);
  });

  it('never converts malformed IPC, denied preparation, or corrupt HTTP bytes into direct fallback', async () => {
    const identity = { sha256: sha256(wasm), byteLength: wasm.byteLength };
    const url = desktopOcctTransportUrl(identity.sha256);
    vi.stubGlobal('location', new URL('app://pointercad/index.html'));
    vi.stubGlobal('__PCAD_DESKTOP_OCCT_IDENTITY__', identity);
    const prepare = vi.fn<() => Promise<unknown>>(() => Promise.resolve({ kind: 'direct', reason: 'permission-denied' }));
    vi.stubGlobal('window', { pointercadDesktop: { prepareOcctTransport: prepare } });
    const fetchMock = vi.fn(() => Promise.resolve(asset(wasm, { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' }, 200, url)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchVerifiedOcctForBroker()).rejects.toThrow('build identity');
    expect(fetchMock).not.toHaveBeenCalled();
    prepare.mockRejectedValueOnce(new Error('denied'));
    await expect(fetchVerifiedOcctForBroker()).rejects.toThrow('denied');
    expect(fetchMock).not.toHaveBeenCalled();
    prepare.mockResolvedValue({ kind: 'http', url, ...identity });
    const changed = wasm.slice(); changed[changed.length - 2] = 43;
    fetchMock.mockResolvedValue(asset(changed, { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip' }, 200, url));
    await expect(fetchVerifiedOcctForBroker()).rejects.toThrow('SHA-256');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels pending preparation promptly and never fetches after a late IPC response', async () => {
    const identity = { sha256: sha256(wasm), byteLength: wasm.byteLength };
    vi.stubGlobal('location', new URL('app://pointercad/index.html'));
    vi.stubGlobal('__PCAD_DESKTOP_OCCT_IDENTITY__', identity);
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>(resolve => { release = resolve; });
    vi.stubGlobal('window', { pointercadDesktop: { prepareOcctTransport: () => pending } });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const loading = fetchVerifiedOcctForBroker(controller.signal);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    release({ kind: 'http', url: desktopOcctTransportUrl(identity.sha256), ...identity });
    await pending;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies and compiles the build-pinned app asset for the real parent broker', async () => {
    vi.stubGlobal('location', new URL('app://pointercad/index.html'));
    vi.stubGlobal('__PCAD_DESKTOP_OCCT_IDENTITY__', { sha256: sha256(wasm), byteLength: wasm.byteLength });
    const direct = 'app://pointercad/assets/opencascade.full-fixture.wasm';
    const fetchMock = vi.fn(() => Promise.resolve(asset(wasm, { 'Content-Type': 'application/wasm' }, 200, direct)));
    vi.stubGlobal('fetch', fetchMock);
    const verified = await fetchVerifiedOcctForBroker(undefined, direct);
    if (verified === undefined) throw new Error('app asset silently fell back');
    expect(result(await WebAssembly.instantiate(await compileVerifiedOcctResponse(verified)))).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never silently falls back from missing build identity, cross-host URLs, 404 or altered app bytes', async () => {
    vi.stubGlobal('location', new URL('app://pointercad/index.html'));
    const direct = 'app://pointercad/assets/opencascade.full-fixture.wasm';
    await expect(fetchVerifiedOcctForBroker(undefined, direct)).rejects.toThrow('identity is missing');
    vi.stubGlobal('__PCAD_DESKTOP_OCCT_IDENTITY__', { sha256: sha256(wasm), byteLength: wasm.byteLength });
    const fetchMock = vi.fn(() => Promise.resolve(asset(wasm, { 'Content-Type': 'application/wasm' }, 404, direct)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchVerifiedOcctForBroker(undefined, direct.replace('pointercad', 'other'))).rejects.toThrow('URL');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetchVerifiedOcctForBroker(undefined, direct)).rejects.toThrow('404');
    const changed = wasm.slice(); changed[changed.length - 2] = 43;
    fetchMock.mockImplementation(() => Promise.resolve(asset(changed, { 'Content-Type': 'application/wasm' }, 200, direct)));
    await expect(fetchVerifiedOcctForBroker(undefined, direct)).rejects.toThrow('SHA-256');
  });

  it('uses the bundled direct WASM path for a production HTTP Desktop renderer', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('location', new URL('https://pointercad.example/app/'));
    const fetchMock = vi.fn(() => Promise.resolve(asset(wasm, {
      'Content-Type': 'text/html',
    }, 404, manifestUrl)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchVerifiedOcctForBroker(undefined, '/assets/opencascade.full.wasm'))
      .resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets the parent use the same manifest and decoded response verifier', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('location', new URL('https://pointercad.example/app/'));
    let delivered = wasm;
    const fetchMock = vi.fn((input: string | URL) => {
      if (String(input).endsWith('/occt/manifest.json')) {
        const response = new Response(JSON.stringify(streamingManifest()), {
          headers: { 'Content-Type': 'application/json' },
        });
        Object.defineProperty(response, 'url', { value: manifestUrl });
        return Promise.resolve(response);
      }
      return Promise.resolve(asset(delivered, {
          'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
        }, 200, streamUrl));
    });
    vi.stubGlobal('fetch', fetchMock);
    const verified = await fetchVerifiedOcctForBroker(undefined, '');
    if (verified === undefined) throw new Error('missing parent verification');
    const module = await compileVerifiedOcctResponse(verified);
    expect(result(await WebAssembly.instantiate(module))).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    delivered = wasm.slice();
    delivered[delivered.length - 2] = 43;
    await expect(fetchVerifiedOcctForBroker(undefined, '')).rejects.toThrow('SHA-256');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fails closed when the production parent cannot fetch its manifest', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('location', new URL('https://pointercad.example/app/'));
    const fetchMock = vi.fn(() => Promise.resolve(asset(wasm, {
      'Content-Type': 'text/html',
    }, 404, manifestUrl)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchVerifiedOcctForBroker(undefined, '')).rejects.toThrow('manifest が見つかりません');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON in a production Web manifest without using direct WASM', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('location', new URL('https://pointercad.example/app/'));
    const fetchMock = vi.fn(() => {
      const response = new Response('{', {
        headers: { 'Content-Type': 'application/json' },
      });
      Object.defineProperty(response, 'url', { value: manifestUrl });
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchVerifiedOcctForBroker(undefined, '')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('verifies decoded HTTP bytes before native streaming compile and glue instantiation', async () => {
    const stages: string[] = [];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(asset(wasm, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }, 200, streamUrl))));
    const factory = vi.fn(async (options: OcctModuleOptions) => {
      expect(options.wasmBinary).toBeUndefined();
      expect(options.instantiateWasm).toBeTypeOf('function');
      let actual: unknown;
      options.instantiateWasm?.({}, (instance) => { actual = result(instance); });
      await vi.waitFor(() => { expect(actual).toBe(42); });
      return { actual };
    });
    const output = await loadManifestOcct(
      { manifest: streamingManifest(), url: manifestUrl }, factory, (name) => { stages.push(name); },
    );
    expect(output.actual).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(stages).toEqual([
      'fetch-start', 'response-headers', 'downloaded', 'verify-start', 'verified',
      'compile-start', 'compile-end', 'instantiate', 'factory-start',
      'native-instantiate-start', 'native-instantiate-end', 'receive-instance-start',
      'receive-instance-end', 'factory-end', 'instantiate-end',
    ]);
  });

  it('reports factory completion only when it resolves and ignores new diagnostic callback failures', async () => {
    const stages: string[] = [];
    let releaseFactory!: () => void;
    const factoryCompletion = new Promise<void>(resolve => { releaseFactory = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(asset(wasm, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }, 200, streamUrl))));
    const loading = loadManifestOcct({ manifest: streamingManifest(), url: manifestUrl }, async options => {
      const native = await new Promise<WebAssembly.Instance>(resolve => {
        if (options.instantiateWasm === undefined) throw new Error('verified hook missing');
        options.instantiateWasm({}, instance => { resolve(instance); });
      });
      await factoryCompletion;
      return result(native);
    }, name => {
      stages.push(name);
      if (name.startsWith('native-instantiate-') || name.startsWith('receive-instance-')
        || name.startsWith('factory-')) throw new Error('diagnostic sink failed');
    });
    await vi.waitFor(() => expect(stages).toContain('receive-instance-end'));
    expect(stages).not.toContain('factory-end');
    expect(stages).not.toContain('instantiate-end');
    releaseFactory();
    expect(await loading).toBe(42);
    expect(stages.indexOf('factory-end')).toBeGreaterThan(stages.indexOf('receive-instance-end'));
    expect(stages.at(-1)).toBe('instantiate-end');
  });

  it('preserves gzip decompression and expanded SHA verification for offline/old assets', async () => {
    const compressed = gzipSync(wasm);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(asset(compressed, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }))));
    const stages: string[] = [];
    const factory = vi.fn(async (options: OcctModuleOptions) => {
      expect(options.instantiateWasm).toBeUndefined();
      expect(options.wasmBinary).toBeDefined();
      if (options.wasmBinary === undefined) throw new Error('missing verified binary');
      const compiled = await WebAssembly.compile(options.wasmBinary);
      return result(await WebAssembly.instantiate(compiled));
    });
    const output = await loadManifestOcct(
      { manifest: manifest(wasm, compressed.byteLength), url: manifestUrl },
      factory, (name) => { stages.push(name); },
    );
    expect(output).toBe(42);
    expect(stages).toEqual(['downloaded', 'verified', 'instantiate']);
  });

  it('fetches a distinct legacy .bin only when the stream headers are unsuitable', async () => {
    const compressed = gzipSync(wasm);
    const fetchMock = vi.fn((url: URL) => Promise.resolve(
      url.href === streamUrl
        ? asset(wasm, { 'Content-Type': 'application/octet-stream' }, 200, streamUrl)
        : asset(compressed, { 'Content-Type': 'application/octet-stream' }),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const factory = vi.fn(async (options: OcctModuleOptions) => {
      if (options.wasmBinary === undefined) throw new Error('legacy bytes missing');
      return result(await WebAssembly.instantiate(await WebAssembly.compile(options.wasmBinary)));
    });
    expect(await loadManifestOcct({ manifest: streamingManifest(), url: manifestUrl },
      factory, () => undefined)).toBe(42);
    expect(fetchMock.mock.calls.map(([url]) => url.href)).toEqual([streamUrl, assetUrl]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('uses the separate legacy .bin when only Content-Encoding is wrong', async () => {
    const compressed = gzipSync(wasm);
    const fetchMock = vi.fn((url: URL) => Promise.resolve(
      url.href === streamUrl
        ? asset(wasm, { 'Content-Type': 'application/wasm' }, 200, streamUrl)
        : asset(compressed, { 'Content-Type': 'application/octet-stream' }),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const actual = await loadManifestOcct({ manifest: streamingManifest(), url: manifestUrl },
      async (options) => {
        if (options.wasmBinary === undefined) throw new Error('legacy bytes missing');
        return result(await WebAssembly.instantiate(await WebAssembly.compile(options.wasmBinary)));
      }, () => undefined);
    expect(actual).toBe(42);
    expect(fetchMock.mock.calls.map(([url]) => url.href)).toEqual([streamUrl, assetUrl]);
  });

  it('rejects excess decoded bytes without fetching the legacy asset or exposing a module', async () => {
    const larger = new Uint8Array(wasm.byteLength + 1);
    larger.set(wasm);
    const fetchMock = vi.fn(() => Promise.resolve(asset(larger, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }, 200, streamUrl)));
    vi.stubGlobal('fetch', fetchMock);
    const factory = vi.fn(() => Promise.resolve(1));
    await expect(loadManifestOcct({ manifest: streamingManifest(), url: manifestUrl },
      factory, () => undefined)).rejects.toThrow('上限');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a conflicting encoded Content-Length instead of using the legacy asset', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(asset(wasm, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
      'Content-Length': '1',
    }, 200, streamUrl)));
    vi.stubGlobal('fetch', fetchMock);
    const factory = vi.fn(() => Promise.resolve(1));
    await expect(loadManifestOcct({ manifest: streamingManifest(), url: manifestUrl },
      factory, () => undefined)).rejects.toThrow('圧縮輸送長');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects redirects and an already aborted request without falling back', async () => {
    const redirected = asset(wasm, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }, 200, streamUrl);
    Object.defineProperty(redirected, 'redirected', { value: true });
    const fetchMock = vi.fn(() => Promise.resolve(redirected));
    vi.stubGlobal('fetch', fetchMock);
    const factory = vi.fn(() => Promise.resolve(1));
    await expect(loadManifestOcct({ manifest: streamingManifest(), url: manifestUrl },
      factory, () => undefined)).rejects.toThrow('redirect');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    await expect(loadManifestOcct({ manifest: streamingManifest(), url: manifestUrl },
      factory, () => undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a manifest URL with a query before requesting a stream asset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadManifestOcct({
      manifest: streamingManifest(), url: `${manifestUrl}?other=1`,
    }, () => Promise.resolve(1), () => undefined)).rejects.toThrow('URL が不正');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never compiles or instantiates a hash mismatch, even with correct streaming headers', async () => {
    const changed = wasm.slice();
    changed[changed.length - 2] = 43;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(asset(changed, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }, 200, streamUrl))));
    const compile = vi.spyOn(WebAssembly, 'compileStreaming');
    const instantiate = vi.spyOn(WebAssembly, 'instantiate');
    const factory = vi.fn(() => Promise.resolve(1));
    await expect(loadManifestOcct(
      { manifest: streamingManifest(), url: manifestUrl }, factory, () => undefined,
    )).rejects.toThrow('SHA-256');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(compile).not.toHaveBeenCalled();
    expect(instantiate).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('keeps download and compile failures distinct and does not call the glue factory', async () => {
    const factory = vi.fn(() => Promise.resolve(1));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(asset(wasm, {}, 503))));
    await expect(loadManifestOcct(
      { manifest: streamingManifest(), url: manifestUrl }, factory, () => undefined,
    )).rejects.toThrow('HTTP 503');
    expect(factory).not.toHaveBeenCalled();

    const invalid = new Uint8Array([1, 2, 3, 4]);
    const compile = vi.spyOn(WebAssembly, 'compileStreaming');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(asset(invalid, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }, 200, `https://pointercad.example/occt/stream/opencascade.full-${sha256(invalid)}.wasm`))));
    await expect(loadManifestOcct(
      { manifest: streamingManifest(invalid), url: manifestUrl }, factory, () => undefined,
    )).rejects.toThrow();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
  });

  it('propagates native instantiation failure through the Emscripten hook', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(asset(wasm, {
      'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip',
    }, 200, streamUrl))));
    const instantiate = vi.spyOn(WebAssembly, 'instantiate')
      .mockRejectedValueOnce(new Error('native instantiate failed'));
    const stages: string[] = [];
    try {
      await expect(loadManifestOcct(
        { manifest: streamingManifest(), url: manifestUrl },
        (options) => {
          options.instantiateWasm?.({}, () => undefined);
          return Promise.resolve(1);
        },
        (name) => { stages.push(name); },
      )).rejects.toThrow('native instantiate failed');
      expect(stages).toContain('instantiate');
      expect(stages).not.toContain('instantiate-end');
    } finally {
      instantiate.mockRestore();
    }
  });

  it('retains the direct WASM URL path for desktop and manifest-free serving', async () => {
    const stages: string[] = [];
    const directUrl = 'app://pointercad/assets/opencascade.full.wasm';
    const actual = await loadLegacyOcct(directUrl, async (options) => {
      expect(options.wasmBinary).toBeUndefined();
      expect(options.instantiateWasm).toBeUndefined();
      const resolved = options.locateFile?.('opencascade.full.wasm');
      expect(resolved).toBe(directUrl);
      const module = await WebAssembly.compile(wasm);
      return result(await WebAssembly.instantiate(module));
    }, (name) => { stages.push(name); });
    expect(actual).toBe(42);
    expect(stages).toEqual(['instantiate-fallback']);
  });
});
