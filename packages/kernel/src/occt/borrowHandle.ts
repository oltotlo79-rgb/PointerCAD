/** Handle.get() borrows its pointee. Only the owning Handle belongs in the disposal stack. */
export function borrowHandle<T extends { delete(): void }>(handle: { get(): T }): Omit<T, 'delete'> {
  return handle.get();
}
