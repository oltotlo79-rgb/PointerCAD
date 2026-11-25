import { validArchiveReadRange, type ArchiveReadSource } from '@pointercad/io';
import { isObject } from '../valueGuards.js';

/** One selected file and one worker share a private port. No path crosses the port. */
export function serveReadRanges(port: MessagePort, source: ArchiveReadSource, signal?: AbortSignal): void {
  let nextIndex = 0, busy = false;
  port.onmessage = (event: MessageEvent<unknown>): void => {
    const request = event.data;
    if (busy || !isObject(request) || request.index !== nextIndex
      || typeof request.offset !== 'number' || typeof request.length !== 'number'
      || !validArchiveReadRange(source.size, request.offset, request.length)) {
      port.postMessage({ ok: false });
      return;
    }
    const { offset, length } = request, index = nextIndex++;
    busy = true;
    void Promise.resolve().then(() => source.read(offset, length)).then(bytes => {
      if (signal?.aborted) return;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('Short file read');
      // Detach a bounded copy, keeping the provider's ownership intact.
      const owned = new Uint8Array(bytes);
      port.postMessage({ ok: true, index, bytes: owned }, [owned.buffer]);
    }).catch(() => {
      if (!signal?.aborted) port.postMessage({ ok: false });
    }).finally(() => { busy = false; });
  };
}

export function useReadRanges(port: MessagePort, size: number): ArchiveReadSource {
  let nextIndex = 0;
  return {
    size,
    read(offset, length) {
      const index = nextIndex++;
      return new Promise((resolve, reject) => {
        const fail = (): void => reject(new Error('File range could not be read'));
        port.onmessageerror = fail;
        port.onmessage = (event: MessageEvent<unknown>): void => {
          const reply = event.data;
          if (isObject(reply) && reply.ok === true && reply.index === index
            && reply.bytes instanceof Uint8Array && reply.bytes.byteLength === length) resolve(reply.bytes);
          else fail();
        };
        port.postMessage({ index, offset, length });
      });
    },
  };
}

export type { ArchiveReadSource } from '@pointercad/io';
