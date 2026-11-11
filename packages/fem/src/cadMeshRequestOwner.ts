import type { FemClient } from './client.js';

type MeshClient = Pick<FemClient, 'meshTetrahedra'>;

// Both CAD routes claim ownership before awaiting the boundary, before a Worker exists.
const owners = new WeakMap<MeshClient, AbortController>();

export function claimCadMeshRequest(client: MeshClient): AbortController {
  const previous = owners.get(client);
  const owner = new AbortController();
  // Abort listeners run synchronously and may start a newer request themselves.
  owners.set(client, owner);
  previous?.abort();
  return owner;
}

export function isCurrentCadMeshRequest(client: MeshClient, owner: AbortController): boolean {
  return owners.get(client) === owner;
}

export function releaseCadMeshRequest(client: MeshClient, owner: AbortController): void {
  if (isCurrentCadMeshRequest(client, owner)) owners.delete(client);
}
