import { activateConfiguration, createConfiguration, deleteConfiguration, renameConfiguration,
  type ConfigurationChange, type ConfigurationRefusal } from '@pointercad/model';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';

export type ConfigurationAction =
  | { readonly kind: 'create'; readonly name: string }
  | { readonly kind: 'activate' | 'delete'; readonly id: string }
  | { readonly kind: 'rename'; readonly id: string; readonly name: string };
export type ConfigurationActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ConfigurationRefusal | 'partRequired' };

/** 1操作を1文書変更へまとめる。操作時の最新文書を読み、隠れた部品を編集しない。 */
export function runConfigurationAction(action: ConfigurationAction): ConfigurationActionResult {
  const state = useAppStore.getState();
  const document = activePartDocument(state);
  if (document === null) return { ok: false, reason: 'partRequired' };
  const evaluate = (): ConfigurationChange => {
    switch (action.kind) {
      case 'create': return createConfiguration(document, action.name);
      case 'activate': return activateConfiguration(document, action.id);
      case 'rename': return renameConfiguration(document, action.id, action.name);
      case 'delete': return deleteConfiguration(document, action.id);
    }
  };
  const result = evaluate();
  if (!result.ok) return result;
  if (result.document !== document) state.applyDocument(result.document);
  return { ok: true };
}
