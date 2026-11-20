import type { MessageKey } from '../i18n/t.js';

export type ExtrudeOperation = 'new' | 'join' | 'cut';

export type ExtrudeOperationSelection =
  | { readonly ok: true; readonly operation: 'new' }
  | { readonly ok: true; readonly operation: 'union' | 'subtract'; readonly targetFeatureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

export {
  solidOperationSelection as extrudeOperationSelection,
  solidTargetCandidates as extrudeTargetCandidates,
} from './solidOperation.js';
