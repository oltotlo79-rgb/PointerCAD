import { describe, expect, it } from 'vitest';
import {
  DESKTOP_OCCT_TRANSPORT_ORIGIN, desktopOcctTransportOrigin, desktopOcctTransportUrl, validateDesktopOcctTransportReply,
} from './desktopOcctTransportContract.js';

const identity = { sha256: 'a'.repeat(64), byteLength: 42 };
const reply = { kind: 'http', url: desktopOcctTransportUrl(identity.sha256), ...identity };

describe('desktop OCCT transport contract', () => {
  it('keeps the product origin fixed independently of test listener ports', () => {
    expect(DESKTOP_OCCT_TRANSPORT_ORIGIN).toBe('http://127.0.0.1:49721');
  });
  it('pins the exact loopback authority and full decoded SHA path', () => {
    expect(reply.url).toBe(`${DESKTOP_OCCT_TRANSPORT_ORIGIN}/occt/${identity.sha256}.wasm`);
    expect(validateDesktopOcctTransportReply(reply, identity)).toEqual(reply);
  });
  it('permits direct transport only for an explicit unavailable owned port', () => {
    expect(validateDesktopOcctTransportReply({ kind: 'direct', reason: 'port-unavailable' }, identity))
      .toEqual({ kind: 'direct', reason: 'port-unavailable' });
    for (const reason of ['permission-denied', 'cache-miss', 'hash-mismatch', undefined]) {
      expect(() => validateDesktopOcctTransportReply({ kind: 'direct', reason }, identity)).toThrow();
    }
  });
  it('rejects foreign listeners, redirects, queries, fragments, credentials and altered identities', () => {
    for (const url of [reply.url.replace('49721', '49722'), reply.url.replace('127.0.0.1', 'localhost'),
      `${reply.url}?x=1`, `${reply.url}#x`, reply.url.replace('http://', 'http://user@'),
      reply.url.replace(identity.sha256, 'b'.repeat(64))]) {
      expect(() => validateDesktopOcctTransportReply({ ...reply, url }, identity)).toThrow();
    }
    for (const value of [null, {}, { ...reply, byteLength: 43 }, { ...reply, sha256: 'b'.repeat(64) },
      { ...reply, extra: true }, { kind: 'direct', reason: 'port-unavailable', url: reply.url }]) {
      expect(() => validateDesktopOcctTransportReply(value, identity)).toThrow();
    }
  });
  it('accepts a launch-selected loopback port only when that exact origin is expected', () => {
    const origin = desktopOcctTransportOrigin(50123);
    expect(origin).toBe('http://127.0.0.1:50123');
    const selected = { kind: 'http', url: desktopOcctTransportUrl(identity.sha256, origin), ...identity };
    expect(selected.url).toBe(`http://127.0.0.1:50123/occt/${identity.sha256}.wasm`);
    expect(validateDesktopOcctTransportReply(selected, identity, origin)).toEqual(selected);
    // The product default still rejects the selected port, and the selected expectation rejects the product port.
    expect(() => validateDesktopOcctTransportReply(selected, identity)).toThrow();
    expect(() => validateDesktopOcctTransportReply(reply, identity, origin)).toThrow();
    for (const url of [selected.url.replace('50123', '50124'), selected.url.replace('127.0.0.1', 'localhost'),
      `${selected.url}?x=1`, `${selected.url}#x`, selected.url.replace('http://', 'http://user@'),
      selected.url.replace(identity.sha256, 'b'.repeat(64))]) {
      expect(() => validateDesktopOcctTransportReply({ ...selected, url }, identity, origin)).toThrow();
    }
  });
  it('rejects privileged, out-of-range, non-loopback and non-canonical transport origins', () => {
    for (const port of [0, 80, 1023, 65536, 1024.5, Number.NaN]) {
      expect(() => desktopOcctTransportOrigin(port)).toThrow('port is invalid');
    }
    expect(desktopOcctTransportOrigin(1024)).toBe('http://127.0.0.1:1024');
    expect(desktopOcctTransportOrigin(65535)).toBe('http://127.0.0.1:65535');
    for (const origin of ['http://localhost:50123', 'https://127.0.0.1:50123', 'http://127.0.0.1:050123',
      'http://127.0.0.1:65536', 'http://127.0.0.1:1023', 'http://127.0.0.1:50123/', 'http://user@127.0.0.1:50123',
      'http://127.0.0.1', 'http://[::1]:50123']) {
      expect(() => desktopOcctTransportUrl(identity.sha256, origin)).toThrow('origin is invalid');
      expect(() => validateDesktopOcctTransportReply({ kind: 'direct', reason: 'port-unavailable' }, identity, origin))
        .toThrow('origin is invalid');
    }
  });
  it('rejects malformed build identities before accepting a fallback', () => {
    expect(() => desktopOcctTransportUrl('A'.repeat(64))).toThrow();
    for (const byteLength of [0, -1, 1.5, Infinity, 64 * 1024 * 1024 + 1]) {
      expect(() => validateDesktopOcctTransportReply({ kind: 'direct', reason: 'port-unavailable' },
        { ...identity, byteLength })).toThrow();
    }
  });
});
