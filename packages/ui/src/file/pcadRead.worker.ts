import { readDocumentBundle, readDrawingBundle, readPcadFile } from '@pointercad/io';
import { isPcadReadRequest, pcadReadTransferables, type PcadReadReply, type PcadReadRequest } from './pcadReadProtocol.js';

/** Same strict IO readers, solely in the read Worker. The host terminates synchronous work on cancellation. */
async function read(request: PcadReadRequest): Promise<PcadReadReply> {
  switch (request.kind) {
    case 'part': return { id: request.id, kind: 'part', result: readPcadFile(request.bytes) };
    case 'assembly': return { id: request.id, kind: 'assembly', result: await readDocumentBundle(request.bytes, 'assembly') };
    case 'drawing': return { id: request.id, kind: 'drawing', result: await readDrawingBundle(request.bytes) };
  }
}

self.onmessage = (event: MessageEvent<unknown>): void => {
  if (!isPcadReadRequest(event.data)) return;
  const request = event.data;
  void read(request).then(reply => {
    self.postMessage(reply, { transfer: pcadReadTransferables(reply) });
  }).catch((error: unknown) => {
    self.postMessage({ id: request.id, kind: 'failure', message: error instanceof Error ? error.message : String(error) });
  });
};
