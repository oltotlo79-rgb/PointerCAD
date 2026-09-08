import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import * as sequence from './pngSequenceZip.js';

// A real, complete 1×1 PNG. The expectation is independent of the writer.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5foAAAAASUVORK5CYII=', 'base64'));
const frames = (): Uint8Array[] => Array.from({ length: 31 }, () => png.slice());

describe('P7-22 PNG sequence archive', () => {
  it('writes precisely 31 ordered, zero-padded PNG entries through the real ZIP writer', () => {
    const result = sequence.createPngSequenceZip(frames());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = unzipSync(result.bytes);
    expect(Object.keys(entries)).toEqual(Array.from({ length: 31 }, (_, i) => `frame-${String(i).padStart(2, '0')}.png`));
    for (const bytes of Object.values(entries)) expect(bytes).toEqual(png);
    expect(result.frameCount).toBe(31);
    expect(result.inputBytes).toBe(31 * png.length);
  });
  it('fixes ZIP local-header DOS time/date to 1980-01-01 00:00:00', () => {
    const result = sequence.createPngSequenceZip(frames());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    expect(header.getUint16(10, true)).toBe(0);
    expect(header.getUint16(12, true)).toBe(33);
  });
  it('produces equal bytes on separate calls without mutating the frames', () => {
    const input = frames(), before = input.map((item) => item.slice());
    expect(sequence.createPngSequenceZip(input)).toEqual(sequence.createPngSequenceZip(input));
    expect(input).toEqual(before);
  });
  it.each([0, 1, 30, 32])('rejects %i frames instead of inventing or dropping a frame', (count) => {
    expect(sequence.createPngSequenceZip(Array.from({ length: count }, () => png))).toEqual({ ok: false, reason: 'frameCount' });
  });
  it('rejects a sparse sequence', () => {
    const input = frames(); Reflect.deleteProperty(input, '17');
    expect(sequence.createPngSequenceZip(input)).toEqual({ ok: false, reason: 'invalidPng', frame: 17 });
  });
  it.each([0, 7, 32, png.length - 1])('rejects a PNG truncated at %i bytes', (length) => {
    const input = frames(); input[5] = png.slice(0, length);
    expect(sequence.createPngSequenceZip(input)).toEqual({ ok: false, reason: 'invalidPng', frame: 5 });
  });
  it('rejects a non-PNG signature', () => {
    const input = frames(); input[4][0] = 0;
    expect(sequence.createPngSequenceZip(input)).toEqual({ ok: false, reason: 'invalidPng', frame: 4 });
  });
  it('rejects a zero-sized IHDR before allocating the archive', () => {
    const input = frames(); input[6][19] = 0;
    expect(sequence.createPngSequenceZip(input)).toEqual({ ok: false, reason: 'invalidPng', frame: 6 });
  });
  it('rejects bytes after IEND', () => {
    const input = frames(); input[2] = new Uint8Array([...png, 0]);
    expect(sequence.createPngSequenceZip(input)).toEqual({ ok: false, reason: 'invalidPng', frame: 2 });
  });
  it('accepts exact byte caps', () => {
    expect(sequence.createPngSequenceZip(frames(), { maxFrameBytes: png.length, maxTotalBytes: png.length * 31 }).ok).toBe(true);
  });
  it('rejects one byte over the frame cap before ZIP creation', () => {
    expect(sequence.createPngSequenceZip(frames(), { maxFrameBytes: png.length - 1 })).toEqual({ ok: false, reason: 'sizeLimit', frame: 0 });
  });
  it('rejects one byte over the cumulative cap', () => {
    expect(sequence.createPngSequenceZip(frames(), { maxTotalBytes: png.length * 31 - 1 })).toEqual({ ok: false, reason: 'sizeLimit', frame: 30 });
  });
  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid or widened limits %s', (maximum) => {
    expect(sequence.createPngSequenceZip(frames(), { maxTotalBytes: maximum })).toEqual({ ok: false, reason: 'invalidLimit' });
  });
});
