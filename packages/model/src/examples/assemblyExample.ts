import type { AssemblyDocumentBundle } from '../assembly/documentBundle.js';

/** The caller opens the assembly together with its embedded parts. */
export interface AssemblyExample {
  readonly id: 'boltedPlates' | 'aluminumFrame';
  readonly create: () => Promise<AssemblyDocumentBundle>;
}
