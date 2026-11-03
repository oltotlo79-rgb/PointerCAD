import { bucklingUiFixture } from '../../beam/beamBuckling.testSupport.js';
import { useAppStore } from '../useAppStore.js';

/** Open a fresh assembly through the real action so applyAssembly retains its Undo stack. */
export function openAssemblyWithStrength(): void {
  const fixture = bucklingUiFixture();
  const assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Fixture without assembly');
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
}
