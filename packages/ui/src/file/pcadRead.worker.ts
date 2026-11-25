import { Sha256Digest } from '@pointercad/model';
import { ARCHIVE_READ_CHUNK_BYTES, ArchiveReadSourceError, readArchiveRange, readAssemblyFromSource, readDocumentBundle, readDrawingBundle,
  readDrawingFromSource, readPcadFile, readPcadFromSource, type ArchiveReadSource } from '@pointercad/io';
import { useReadRanges } from './pcadReadRanges.js';
import { isPcadRangeReadRequest, isPcadReadRequest, pcadReadTransferables, type PcadRangeReadRequest, type PcadReadReply, type PcadReadRequest } from './pcadReadProtocol.js';

/** Same strict IO readers, solely in the read Worker. The host terminates synchronous work on cancellation. */
async function read(request: PcadReadRequest): Promise<PcadReadReply> {
  switch (request.kind) {
    case 'part': return { id: request.id, kind: 'part', result: readPcadFile(request.bytes) };
    case 'assembly': return { id: request.id, kind: 'assembly', result: await readDocumentBundle(request.bytes, 'assembly') };
    case 'drawing': return { id: request.id, kind: 'drawing', result: await readDrawingBundle(request.bytes) };
  }
}

async function readSavedDigest(source: ArchiveReadSource): Promise<string> {
  const digest = new Sha256Digest();
  for (let offset = 0; offset < source.size; offset += ARCHIVE_READ_CHUNK_BYTES) {
    digest.update(await readArchiveRange(source, offset, Math.min(ARCHIVE_READ_CHUNK_BYTES, source.size - offset)));
  }
  return digest.finish();
}

async function readFromSource(request: PcadRangeReadRequest, source: ArchiveReadSource): Promise<PcadReadReply> {
  switch (request.kind) {
    case 'part': return { id: request.id, kind: 'part', result: await readPcadFromSource(source) };
    case 'assembly': return { id: request.id, kind: 'assembly', result: await readAssemblyFromSource(source) };
    case 'drawing': return { id: request.id, kind: 'drawing', result: await readDrawingFromSource(source) };
  }
}

async function readRanges(request: PcadRangeReadRequest): Promise<PcadReadReply> {
  const source = useReadRanges(request.port, request.size);
  try {
    const reply = await readFromSource(request, source);
    if (reply.kind !== 'failure' && reply.result.ok && request.digest) {
      return { ...reply, savedSha256: await readSavedDigest(source) };
    }
    return reply;
  } finally {
    request.port.close();
  }
}

self.onmessage = (event: MessageEvent<unknown>): void => {
  const request = event.data;
  if (!isPcadReadRequest(request) && !isPcadRangeReadRequest(request)) return;
  const pending = isPcadRangeReadRequest(request) ? readRanges(request) : read(request);
  void pending.then(reply => {
    self.postMessage(reply, { transfer: pcadReadTransferables(reply) });
  }).catch((error: unknown) => {
    const reply: PcadReadReply = { id: request.id, kind: 'failure',
      reason: error instanceof ArchiveReadSourceError ? 'range' : 'rejected',
      message: error instanceof Error ? error.message : String(error) };
    self.postMessage(reply);
  });
};
