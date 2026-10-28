import { decodeNativeBoltPreload, prepareNativeBoltPreload, type NativeBoltPreloadResult, type PreparedNativeBoltPreload } from './nativeBoltPreload.js';

export const NATIVE_BOLT_KIND = 'native-bolt-preload-stages' as const;
/** The plan is deliberately unknown at wire admission; asynchronous full validation precedes every asset read. */
export interface NativeBoltPreloadWireInput { readonly source: { readonly documentId: string; readonly revision: number }; readonly plan: unknown }
export interface PreparedNativeBoltPreloadJob { readonly source: NativeBoltPreloadWireInput['source']; readonly prepared: PreparedNativeBoltPreload }
export interface NativeBoltPreloadOwnedResult extends NativeBoltPreloadResult { readonly kind: typeof NATIVE_BOLT_KIND; readonly source: NativeBoltPreloadWireInput['source'] }
const numericKeys = ['schema','method','nativeContactSolver','structuralCertification','lockedShorteningM','lockAfterState','boltComplianceMPerN','memberComplianceMPerN','contact','states','planSha256'] as const;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(k=>!Object.hasOwn(value,k))) throw Error('native-preload-wire-shape');
  return value;
}
function source(value: unknown): NativeBoltPreloadWireInput['source'] {
  const row=fields(value,['documentId','revision']);
  if(typeof row.documentId!=='string'||row.documentId.length<1||row.documentId.length>256||typeof row.revision!=='number'||!Number.isSafeInteger(row.revision)||row.revision<0)throw Error('native-preload-source-identity');
  return {documentId:row.documentId,revision:row.revision};
}
export function readNativeBoltPreloadWireInput(value: unknown): NativeBoltPreloadWireInput {
  const row=fields(value,['source','plan']);return {source:source(row.source),plan:row.plan};
}
export function isNativeBoltPreloadWireInput(value: unknown): value is NativeBoltPreloadWireInput {
  try {readNativeBoltPreloadWireInput(value);return true;}catch{return false;}
}
/** Local preparation only. Never post this object or either owning token to another Worker. */
export async function prepareNativeBoltPreloadJob(value: unknown): Promise<PreparedNativeBoltPreloadJob> {
  const wire=readNativeBoltPreloadWireInput(value),prepared=await prepareNativeBoltPreload(wire.plan);
  return Object.freeze({source:Object.freeze(wire.source),prepared});
}
/** Preliminary discrimination, as for existing bindings. The owner must fully decode before accepting a result. */
export function isNativeBoltPreloadOwnedResult(value: unknown): value is NativeBoltPreloadOwnedResult {
  try {
    const row=fields(value,[...numericKeys,'kind','source']);source(row.source);
    return row.kind===NATIVE_BOLT_KIND&&row.schema==='pointercad-native-bolt-preload-result/1'&&row.nativeContactSolver===false&&row.structuralCertification===false
      &&typeof row.planSha256==='string'&&/^[0-9a-f]{64}$/u.test(row.planSha256)&&Array.isArray(row.states)&&row.states.length>=2&&row.states.length<=32&&record(row.contact);
  }catch{return false;}
}
export function decodeNativeBoltPreloadOwned(value: unknown, job: PreparedNativeBoltPreloadJob): NativeBoltPreloadOwnedResult {
  const row=fields(value,[...numericKeys,'kind','source']);const {kind,source:rawSource,...numeric}=row;const supplied=source(rawSource);
  if(kind!==NATIVE_BOLT_KIND||supplied.documentId!==job.source.documentId||supplied.revision!==job.source.revision)throw Error('native-preload-result-owner');
  const decoded=decodeNativeBoltPreload(numeric,job.prepared);
  return {...decoded,kind:NATIVE_BOLT_KIND,source:job.source};
}
export function nativeBoltPreloadOwnedMatches(value: unknown,job: PreparedNativeBoltPreloadJob): NativeBoltPreloadOwnedResult|null {
  try{return decodeNativeBoltPreloadOwned(value,job);}catch{return null;}
}
