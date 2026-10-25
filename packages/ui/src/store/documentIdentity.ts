/** Typed failure is handled only at document-creation boundaries. */
export class SecurePartIdentityError extends Error {
  constructor(cause?: unknown) {
    super('Secure document identity is unavailable', cause === undefined ? undefined : { cause });
    this.name = 'SecurePartIdentityError';
  }
}

/** Fresh lineage uses secure entropy only; persisted documents never call this helper. */
export function createPartLineageId(): string {
  return `part-uuid:${createSecureUuid()}`;
}

/** Secure UUID for transient session and asset identity; never rewrites saved lineage. */
export function createSecureUuid(): string {
  try { return secureUuid(); }
  catch (error) { throw new SecurePartIdentityError(error); }
}

/** Nominal prepared value: committing it requires no additional entropy. */
export class PreparedDocumentSession {
  readonly #id: string;

  private constructor(id: string) { this.#id = id; }

  static prepare(): PreparedDocumentSession {
    return new PreparedDocumentSession(createSecureUuid());
  }

  get id(): string { return this.#id; }

  static idOf(session: PreparedDocumentSession): string {
    if (!(session instanceof PreparedDocumentSession) || !(#id in session)) {
      throw new SecurePartIdentityError();
    }
    return session.#id;
  }
}

export function prepareDocumentSession(): PreparedDocumentSession {
  return PreparedDocumentSession.prepare();
}

export function documentSessionId(session?: PreparedDocumentSession): string {
  return PreparedDocumentSession.idOf(session === undefined ? prepareDocumentSession() : session);
}

function secureUuid(): string {
  const entropy = globalThis.crypto;
  if (entropy === undefined) throw new Error('Secure document identity is unavailable');
  if (typeof entropy.randomUUID === 'function') return entropy.randomUUID();
  if (typeof entropy.getRandomValues !== 'function') {
    throw new Error('Secure document identity is unavailable');
  }
  const bytes = entropy.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

