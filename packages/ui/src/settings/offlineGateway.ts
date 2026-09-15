export interface OfflineStatus {
  readonly phase: 'idle' | 'checking' | 'preparing' | 'ready' | 'error';
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly storedFiles: number;
  readonly totalFiles: number;
  readonly availableBytes?: number;
  readonly reason?: 'unsupported' | 'busy' | 'download' | 'storage' | 'registration' | 'missing' | 'cancelled';
}
export interface OfflineGateway {
  getSnapshot(this: void): OfflineStatus;
  subscribe(this: void, listener: () => void): () => void;
  refresh(): Promise<void>;
  prepare(): Promise<void>;
  cancel(): void;
}

let installed: OfflineGateway | undefined;
/** Web installs this before React starts. It has no access to documents, history or recovery copies. */
export function setOfflineGateway(gateway: OfflineGateway): void { installed = gateway; }
export function getOfflineGateway(): OfflineGateway | undefined { return installed; }
