/// <reference lib="dom" />
import { readFile, stat } from 'node:fs/promises';
import type * as NodeFs from 'node:fs';
import { basename } from 'node:path';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { assertReadWorkerClosed, nativeReadWorkers, observeRead, writeReadEvidence } from './readResponseObservation.js';
import { waitForStartupHealth } from './startupHealth.js';

// Electron serializes evaluate callbacks. Their process is the actual Node global in main.
declare const process: typeof import('node:process');

declare global {
  interface Window {
    pcadLargeReadRanges?: number[];
    pcadLargeReadProvider?: { slices: number[]; full: number };
  }
}

async function observeRangeReads(page: Page, sourceBytes: number): Promise<void> {
  await page.evaluate(size => {
    const ranges: number[] = [], slices: number[] = [], provider = { slices, full: 0 };
    window.pcadLargeReadRanges = ranges;
    window.pcadLargeReadProvider = provider;
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = new Proxy(send, {
      apply(original, receiver, args: unknown[]): unknown {
        const reply = args[0];
        if (typeof reply === 'object' && reply !== null && 'ok' in reply && reply.ok === true
          && 'index' in reply && typeof reply.index === 'number' && 'bytes' in reply && reply.bytes instanceof Uint8Array) {
          ranges.push(reply.bytes.byteLength);
        }
        return Reflect.apply(original, receiver, args);
      },
    });
    const slice = Blob.prototype.slice, read = Blob.prototype.arrayBuffer;
    Blob.prototype.slice = function(start, end, type) {
      const piece = slice.call(this, start, end, type);
      if (this instanceof File && this.size === size) provider.slices.push(piece.size);
      return piece;
    };
    Blob.prototype.arrayBuffer = function() {
      if (this instanceof File && this.size === size) provider.full += 1;
      return read.call(this);
    };
  }, sourceBytes);
}

async function observeSelectedHandle(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate((_, chosen) => {
    const fs: typeof NodeFs.promises = process.getBuiltinModule('fs').promises;
    const ranges: number[] = [], evidence = { ranges, full: 0, closes: 0 };
    Reflect.set(process, 'pcadLargeReadHandle', evidence);
    fs.readFile = new Proxy(fs.readFile, { apply(original, receiver, args: unknown[]): unknown {
      if (args[0] === chosen) evidence.full += 1;
      return Reflect.apply(original, receiver, args);
    } });
    fs.open = new Proxy(fs.open, { apply(original, receiver, args: unknown[]): unknown {
      const pending: unknown = Reflect.apply(original, receiver, args);
      if (args[0] !== chosen || !(pending instanceof Promise)) return pending;
      return pending.then((handle: unknown) => {
        if (typeof handle !== 'object' || handle === null || !('read' in handle) || typeof handle.read !== 'function'
          || !('close' in handle) || typeof handle.close !== 'function') throw new Error('Missing actual file descriptor');
        handle.read = new Proxy(handle.read, { apply(reader, owner, values: unknown[]): unknown {
          if (typeof values[2] !== 'number') throw new Error('Missing actual read length');
          evidence.ranges.push(values[2]);
          return Reflect.apply(reader, owner, values);
        } });
        handle.close = new Proxy(handle.close, { apply(close, owner, values: unknown[]): unknown {
          evidence.closes += 1;
          return Reflect.apply(close, owner, values);
        } });
        return handle;
      });
    } });
  }, path);
}

async function observedAttachment(page: Page) {
  return page.evaluate(async () => {
    const audit = window.pcadReadObservation, attachment = audit?.orphan;
    if (audit === undefined || !(attachment instanceof Uint8Array) || !(attachment.buffer instanceof ArrayBuffer)) {
      throw new Error('Missing decoded attachment from the real read Worker');
    }
    const view = new Uint8Array(attachment.buffer, attachment.byteOffset, attachment.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
    return {
      attachmentBytes: attachment.byteLength,
      attachmentSha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''),
      wholeInput: audit.source !== null,
      ranges: window.pcadLargeReadRanges,
      provider: window.pcadLargeReadProvider,
    };
  });
}

export async function largeNativeReadFlow(page: Page, info: TestInfo, fixture: { path: string; sourceSha256: string },
  app?: ElectronApplication): Promise<void> {
  const { path, sourceSha256 } = fixture;
  const sourceBytes = (await stat(path)).size;
  const oracle: unknown = JSON.parse(await readFile(path + '.oracle.json', 'utf8'));
  if (typeof oracle !== 'object' || oracle === null || !('attachmentBytes' in oracle) || !('attachmentSha256' in oracle)
    || !('sourceBytes' in oracle) || typeof oracle.attachmentBytes !== 'number' || typeof oracle.attachmentSha256 !== 'string') {
    throw new Error('Missing fixture oracle');
  }
  expect(sourceBytes).toBe(oracle.sourceBytes);
  expect(sourceBytes).toBeGreaterThan(260 * 1024 * 1024);
  if ('sourceSha256' in oracle) expect(sourceSha256).toBe(oracle.sourceSha256);
  await waitForStartupHealth(page, info);
  await observeRangeReads(page, sourceBytes);
  if (app !== undefined) await observeSelectedHandle(app, path);
  await observeRead(page, true, app);
  const workers = nativeReadWorkers(page);
  await openSaveFlowFile(page, path, app);
  await expect(page.locator('.pcad-statusbar__file')).toHaveText(basename(path));
  await assertReadWorkerClosed(workers);
  const restored = await observedAttachment(page);
  expect(restored.attachmentBytes).toBe(oracle.attachmentBytes);
  expect(restored.attachmentSha256).toBe(oracle.attachmentSha256);
  expect(restored.wholeInput).toBe(false);
  expect(restored.ranges?.length).toBeGreaterThan(256);
  const native: unknown = app === undefined ? restored.provider
    : await app.evaluate((): unknown => Reflect.get(process, 'pcadLargeReadHandle'));
  const edition = app === undefined ? 'web' : 'desktop';
  await writeReadEvidence(info, `a14-large-native-${edition}`, { sourceBytes, sourceSha256, oracle, restored, native });
  if (app === undefined) {
    expect(native).toMatchObject({ full: 0, slices: restored.ranges });
  } else {
    expect(native).toMatchObject({ full: 0, closes: 1 });
    if (typeof native !== 'object' || native === null || !('ranges' in native) || !Array.isArray(native.ranges)) {
      throw new Error('Actual Desktop file reads were not observed');
    }
    const lengths = native.ranges.filter((value: unknown): value is number => typeof value === 'number');
    expect(lengths).toHaveLength(native.ranges.length);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(restored.ranges?.reduce((sum, length) => sum + length, 0));
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1024 * 1024);
  }
  const ranges = restored.ranges ?? [];
  const largestRange = Math.max(...ranges);
  expect(largestRange).toBe(1024 * 1024);
  console.log(`[A-14 native open] ${JSON.stringify({ edition, sourceBytes, sourceSha256,
    attachmentBytes: restored.attachmentBytes, attachmentSha256: restored.attachmentSha256,
    readCount: ranges.length, largestRange, wholeInput: restored.wholeInput, native })}`);
}
