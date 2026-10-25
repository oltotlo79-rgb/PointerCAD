import type { AppState } from '../store/appState.js';
import { repairContextTokens } from './referenceRepairContext.js';

/** Per mounted consumer, retaining only its latest relevant store snapshot.
 * Session admission still checks the live store at hover/commit time.
 */
export function createRepairStateSelector(includeHover = false): (state: AppState) => AppState {
  let previous: AppState | undefined;
  let tokens: readonly unknown[] = [];
  return state => {
    const next = [...repairContextTokens(state), state.errorMessage,
      ...(includeHover ? [state.hoveredElementId] : [])];
    if (previous !== undefined && next.length === tokens.length
      && next.every((token, index) => Object.is(token, tokens[index]))) return previous;
    tokens = next;
    previous = state;
    return state;
  };
}
