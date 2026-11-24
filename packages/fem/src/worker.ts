import { analyzeSolidFiniteInBrowser } from './offlineBrowser.js';
import { analyzeFrictionContactInBrowser, analyzeWeldSpanContactInBrowser } from './offlineBrowser.js';
import { analyzeNativeBoltPreloadInBrowser } from './offlineBrowser.js';
import { analyzeSolidContactInBrowser } from './offlineBrowser.js';
import { SolidContactRuntimeError } from './solidContactRuntime.js';
import { FemCodedError, FemRefusalError, nativeFailureCode, nativeRefusal } from './femCodedError.js';
import { analyzeInBrowser, analyzeModalInBrowser, analyzeBucklingInBrowser, analyzeTransientInBrowser,
  analyzePlasticBarInBrowser, analyzeContactInBrowser, analyzeBoltContactInBrowser, analyzeWeldContactInBrowser, analyzeJointContactInBrowser, analyzeSolidInBrowser, analyzeSolidPlasticInBrowser,
  meshTetrahedraInBrowser, qualifyInBrowser } from './offlineBrowser.js';
import { FEM_PROTOCOL, isRequest, type FemFailureCode, type FemPhase, type FemReply } from './protocol.js';
import { analyzeJointInitialStrainInBrowser } from './offlineBrowser.js';
import { analyzeSolidModalInBrowser } from './offlineBrowser.js';
import { analyzeSolidBucklingInBrowser } from './offlineBrowser.js';
import { analyzeImpactInBrowser } from './offlineBrowser.js';
import { analyzeFrameBoltContactInBrowser } from './offlineBrowser.js';
import { analyzeShellInBrowser } from './offlineBrowser.js';

declare const self: DedicatedWorkerGlobalScope;
let used = false;
let closed = false;
const closeOnce = (): void => { if (!closed) { closed = true; self.close(); } };
self.onmessage = (event: MessageEvent<unknown>): void => {
  if (closed || used || !isRequest(event.data)) { closeOnce(); return; }
  used = true;
  const request = event.data;
  let phase: FemPhase = 'loading-assets';
  const send = (reply: FemReply): void => { if (!closed) self.postMessage(reply); };
  const notify=(next:FemPhase):void=>{
    phase = next;
    send({ protocol: FEM_PROTOCOL, kind: 'phase', identity: request.identity, phase });
  };
  const work = request.kind === 'analyze-solid-finite-j2' ? analyzeSolidFiniteInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-friction-contact' ? analyzeFrictionContactInBrowser(request.input, request.solverOptions, notify)
    : request.kind === 'analyze-solid-contact' ? analyzeSolidContactInBrowser(request.input, notify)
    : request.kind === 'analyze-native-bolt-preload' ? analyzeNativeBoltPreloadInBrowser(request.input, notify)
    : request.kind === 'qualify-oofem-beam' ? qualifyInBrowser(notify)
    : request.kind === 'analyze-solid-plastic-tet4' ? analyzeSolidPlasticInBrowser(request.input, notify)
    : request.kind === 'analyze-solid-buckling-tet4' ? analyzeSolidBucklingInBrowser(request.input, notify)
    : request.kind === 'analyze-solid-modal-tet4' ? analyzeSolidModalInBrowser(request.input, notify)
    : request.kind === 'analyze-solid-tet4' ? analyzeSolidInBrowser(request.input, notify)
    : request.kind === 'analyze-shell-tr-shell02' ? analyzeShellInBrowser(request.input, notify)
    : request.kind === 'mesh-cad-convex-tetra' ? meshTetrahedraInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-buckling-3d' ? analyzeBucklingInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-transient-3d' ? analyzeTransientInBrowser(request.input, notify)
    : request.kind === 'analyze-plastic-bar-1d' ? analyzePlasticBarInBrowser(request.input, notify)
    : request.kind === 'analyze-frame-bolt-contact' ? analyzeFrameBoltContactInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-bolt-contact' ? analyzeBoltContactInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-weld-span-contact' ? analyzeWeldSpanContactInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-weld-contact' ? analyzeWeldContactInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-joint-contact' ? analyzeJointContactInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-impact-3d' ? analyzeImpactInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-joint-initial-strain' ? analyzeJointInitialStrainInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-contact-3d' ? analyzeContactInBrowser(request.input, notify)
    : request.kind === 'analyze-beam-modal-3d' ? analyzeModalInBrowser(request.document, notify)
      : analyzeInBrowser(request.document, notify);
  void work.then(result => {
    send({ protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // 種類は投げた所の符号で決め、文は読まない(0b-4)。計算部(Pyodide・Python)が包み直した誤りだけは、境目の 1 か所
    // (femCodedError.ts の nativeFailureCode・nativeRefusal)で文から読む。取得の拒否の印は今までどおりほかの符号より先。
    const code: FemFailureCode = nativeFailureCode(message)
      ?? (error instanceof FemCodedError ? error.code : phase === 'solving' ? 'solver-failed' : 'runtime-initialization');
    const refusal = error instanceof FemRefusalError ? error.refusal : nativeRefusal(message);
    send({ protocol: FEM_PROTOCOL, kind: 'failure', identity: request.identity,
      failure: { code, message: message.slice(0, 4096) || 'FEM runtime failed', ...(refusal === undefined ? {} : { refusal }),
        ...(error instanceof SolidContactRuntimeError ? { contactDiagnostics: error.contactDiagnostics } : {}) } });
  }).finally(closeOnce);
};
