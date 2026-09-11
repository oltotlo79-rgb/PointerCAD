import type { AssemblyKernelBridge } from '@pointercad/model';
import { createScriptExecutor } from '@pointercad/model/scripting';
import { useAppStore } from '../store/useAppStore.js';
import { loadScriptLibrary } from './scriptActions.js';

export function attachScripting(bridge: AssemblyKernelBridge): () => void {
  const executor = createScriptExecutor(bridge);
  useAppStore.setState({ scriptExecutor: executor });
  void loadScriptLibrary();
  return () => {
    if (useAppStore.getState().scriptExecutor !== executor) return;
    useAppStore.getState().cancelScript(); useAppStore.setState({ scriptExecutor: null });
  };
}
