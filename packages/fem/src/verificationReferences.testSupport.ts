import type { VerificationKind } from './verificationComparison.testSupport.js';

/**
 * Published sources behind the seven fixed verification formulas, kept apart from this repository's own
 * substitution of each fixture's dimensions, supports and loads. A source supports a principle, formula or
 * assumption only; none of these sources tested or validated the fixtures in verificationComparison.testSupport.ts.
 * Only a source whose primary text was retrieved and located (byte SHA-256 recorded) can make a kind 'verified';
 * bibliographic records and unretrieved pages stay listed but leave the kind 'incomplete'.
 */
 type SourceConfirmation = 'primary-text' | 'bibliographic-record' | 'not-retrieved';
 interface SourceRetrieval {
  /** ISO time of the retrieval (JST offset). */
  readonly retrievedAt: string;
  readonly bytes: number;
  /** SHA-256 of the retrieved original bytes. */
  readonly sha256: string;
  /** Headings or equation identifiers actually located in the retrieved text. */
  readonly located: readonly string[];
}
interface PublishedSource {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly authors: string;
  /** Publisher, journal volume/pages, version or hosting, as shown by the source or its record. */
  readonly publication: string;
  /** Where the supporting text is: an actual heading or equation identifier, never an invented page. */
  readonly locator: string;
  readonly supports: string;
  readonly applicability: string;
  readonly confirmation: SourceConfirmation;
  /** Required for 'primary-text'; absent otherwise. */
  readonly retrieval?: SourceRetrieval;
  /** Why the primary text was not verified; required unless 'primary-text'. */
  readonly unverifiedReason?: string;
}
export interface FixtureDerivation {
  readonly kind: VerificationKind;
  readonly caseId: string;
  readonly sourceIds: readonly string[];
  readonly formula: string;
  /** Algebraic substitution of the fixture's own values, derived in this repository. */
  readonly substitution: string;
  /** Conditions read from the original test, which the formula needs. */
  readonly conditions: string;
  readonly statement: string;
  /** Steps derived here without an external source (stated, not attributed to any publication). */
  readonly ownSteps: readonly string[];
  /** Principles the formula needs whose primary text was not verified; any entry leaves the kind incomplete. */
  readonly sourceGaps: readonly string[];
}
 type ReferenceStatus = 'verified' | 'incomplete';

export const VERIFICATION_KINDS: readonly VerificationKind[] = ['linear-static', 'buckling', 'modal', 'plastic-solid', 'contact', 'impact', 'fatigue'];
const DERIVATION_STATEMENT = 'Independent algebraic derivation for this fixture by this repository; the cited sources support only the principle, formula and assumptions and did not test this fixture.';

function filled(value: string): boolean { return value.trim().length > 0; }

function checkSource(source: PublishedSource): void {
  let url: URL;
  try { url = new URL(source.url); } catch { throw new Error(`verification references: invalid URL for ${source.id}`); }
  if (url.protocol !== 'https:') throw new Error(`verification references: non-https URL for ${source.id}`);
  if (![source.title, source.authors, source.publication, source.locator, source.supports, source.applicability].every(filled))
    throw new Error(`verification references: incomplete source ${source.id}`);
  const retrieval = source.retrieval;
  if (source.confirmation === 'primary-text') {
    if (retrieval === undefined || source.unverifiedReason !== undefined) throw new Error(`verification references: primary text without retrieval record for ${source.id}`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(retrieval.retrievedAt) || !/^[0-9a-f]{64}$/.test(retrieval.sha256)
      || !Number.isInteger(retrieval.bytes) || retrieval.bytes <= 0 || retrieval.located.length === 0 || !retrieval.located.every(filled))
      throw new Error(`verification references: incomplete retrieval record for ${source.id}`);
  } else if (retrieval !== undefined || source.unverifiedReason === undefined || !filled(source.unverifiedReason)) {
    throw new Error(`verification references: unverified source ${source.id} must state why and carry no retrieval record`);
  }
}

/**
 * Throw when any kind lacks a derivation or a linked source, or a source lacks URL, edition, locator or (for
 * primary text) its retrieval record. Return per kind whether a retrieved primary text supports it with no gap left.
 */
export function validateVerificationReferences(sources: readonly PublishedSource[], derivations: Readonly<Partial<Record<VerificationKind, FixtureDerivation>>>): Readonly<Record<VerificationKind, ReferenceStatus>> {
  const byId = new Map<string, PublishedSource>();
  for (const source of sources) {
    if (!filled(source.id) || byId.has(source.id)) throw new Error(`verification references: missing or duplicate source id '${source.id}'`);
    checkSource(source);
    byId.set(source.id, source);
  }
  const keys = Object.keys(derivations);
  if (keys.length !== VERIFICATION_KINDS.length || !VERIFICATION_KINDS.every(kind => keys.includes(kind)))
    throw new Error('verification references: derivations must cover exactly the seven kinds');
  const caseIds = new Set<string>();
  const status: Partial<Record<VerificationKind, ReferenceStatus>> = {};
  for (const kind of VERIFICATION_KINDS) {
    const derivation = derivations[kind];
    if (derivation === undefined || derivation.kind !== kind) throw new Error(`verification references: missing derivation for ${kind}`);
    if (!filled(derivation.caseId) || caseIds.has(derivation.caseId)) throw new Error(`verification references: missing or duplicate case id for ${kind}`);
    caseIds.add(derivation.caseId);
    const linked = derivation.sourceIds.map(id => byId.get(id));
    if (linked.length === 0 || new Set(derivation.sourceIds).size !== linked.length || linked.some(source => source === undefined))
      throw new Error(`verification references: unlinked sources for ${kind}`);
    if (![derivation.formula, derivation.substitution, derivation.conditions].every(filled)) throw new Error(`verification references: incomplete derivation for ${kind}`);
    if (derivation.statement !== DERIVATION_STATEMENT) throw new Error(`verification references: derivation for ${kind} must be stated as this repository's own derivation`);
    if (!derivation.ownSteps.every(filled) || !derivation.sourceGaps.every(filled)) throw new Error(`verification references: empty step or gap for ${kind}`);
    const primary = linked.some(source => source?.confirmation === 'primary-text');
    status[kind] = primary && derivation.sourceGaps.length === 0 ? 'verified' : 'incomplete';
  }
  return {
    'linear-static': status['linear-static'] ?? 'incomplete', buckling: status.buckling ?? 'incomplete', modal: status.modal ?? 'incomplete',
    'plastic-solid': status['plastic-solid'] ?? 'incomplete', contact: status.contact ?? 'incomplete', impact: status.impact ?? 'incomplete',
    fatigue: status.fatigue ?? 'incomplete',
  };
}
