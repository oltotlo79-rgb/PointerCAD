import {uiMessage} from './uiMessages.js';

// Type-only JSON access is erased; Node never imports a JSON module at runtime.
// Centralize the catalog; misspelled direction keys fail typecheck before browser work.
type Messages=typeof import('../../packages/ui/src/i18n/ja/math.json');
type Suffix<K>=K extends `functionDirection.${infer Name}`?Name:never;
export function functionDirectionMessage(key:Suffix<keyof Messages>):string {
  return uiMessage('math',`functionDirection.${key}`);
}
