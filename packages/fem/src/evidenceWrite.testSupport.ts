import { writeSync } from 'node:fs';

// Test-only helper. Evidence lines are written synchronously to the RUN stream (fd 1). When that
// stream is a non-blocking pipe that is full, Node's fs.writeSync throws EAGAIN instead of waiting,
// which failed the Linux unit job (A-15). This writes the whole buffer: it continues after partial
// writes and waits briefly then retries on EAGAIN. Every other error is rethrown unchanged.
export interface EvidenceWriteIo {
  write: (fd: number, chunk: Uint8Array) => number;
  wait: (ms: number) => void;
  maxWaitMs: number;
}

const WAIT_STEP_MS = 5;
const MAX_WAIT_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const defaultEvidenceWriteIo: EvidenceWriteIo = {
  write: (fd, chunk) => writeSync(fd, chunk),
  wait: sleepSync,
  maxWaitMs: MAX_WAIT_MS,
};

function isEagain(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EAGAIN';
}

export function writeEvidenceSync(fd: number, data: string | Uint8Array,
  io: EvidenceWriteIo = defaultEvidenceWriteIo): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let offset = 0, waitedMs = 0;
  while (offset < bytes.length) {
    try {
      offset += io.write(fd, bytes.subarray(offset));
    } catch (error) {
      if (!isEagain(error)) throw error;
      if (waitedMs >= io.maxWaitMs) {
        throw new Error('Evidence write stayed EAGAIN for ' + waitedMs + ' ms: wrote ' + offset + ' of '
          + bytes.length + ' bytes', { cause: error });
      }
      io.wait(WAIT_STEP_MS);
      waitedMs += WAIT_STEP_MS;
    }
  }
}
