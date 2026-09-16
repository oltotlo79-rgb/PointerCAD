import type { FeatureHelpBinding } from './featureHelpBindings.js';

export interface HelpRequirement {
  readonly id: string;
  readonly sourceLine: number;
  readonly description: string;
  readonly priority: string;
}
export interface HelpFeatureCoverageEntry extends HelpRequirement, FeatureHelpBinding {}
export interface HelpFeatureCoverage {
  readonly entries: readonly HelpFeatureCoverageEntry[];
  readonly pending: readonly string[];
  /** Links alone do not certify the completeness of the chapter text or actual screen evidence. */
  readonly contentCertified: false;
}

/** Read primary requirement tables only; comparison tables and later notes are not new requirements. */
export function parseHelpRequirements(markdown: string): readonly HelpRequirement[] {
  const requirements: HelpRequirement[] = [], seen = new Set<string>();
  let inTable = false;
  for (const [index, raw] of markdown.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (/^\|\s*ID\s*\|\s*要件\s*\|\s*優先度\s*\|$/u.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    // The canonical table continues after blank lines (for example FR-433 onward).
    if (line === '') continue;
    if (/^\|\s*ID\s*\|/u.test(line)) { inTable = false; continue; }
    if (!line.startsWith('|')) { inTable = false; continue; }
    if (/^\|[- :|]+\|$/u.test(line)) continue;
    const match = /^\|\s*(FR-\d+)\s*\|\s*(.+)\s*\|\s*([^|]+)\s*\|$/u.exec(line);
    if (match === null) throw new Error(`Unrecognized requirement row at line ${String(index + 1)}`);
    const [, id, description, rawPriority] = match, priority = rawPriority.trim();
    if (seen.has(id)) throw new Error(`Duplicate requirement: ${id}`);
    if (!['Must', 'Should', 'Could', '将来'].includes(priority)) throw new Error(`Unknown requirement priority: ${id}`);
    seen.add(id); requirements.push({ id, sourceLine: index + 1, description: description.trim(), priority });
  }
  if (requirements.length === 0) throw new Error('No primary requirements found');
  return Object.freeze(requirements);
}

export function buildHelpFeatureCoverage(
  requirements: readonly HelpRequirement[], topics: readonly { readonly id: string }[], bindings: readonly FeatureHelpBinding[],
): HelpFeatureCoverage {
  const required = new Set(requirements.map(item => item.id));
  if (required.size !== requirements.length || required.size === 0) throw new Error('Empty or duplicate requirements');
  const topicIds = new Set(topics.map(topic => topic.id));
  if (topicIds.size !== topics.length) throw new Error('Duplicate help topics');
  const byId = new Map<string, FeatureHelpBinding>();
  for (const binding of bindings) {
    if (!required.has(binding.featureId)) throw new Error(`Unknown feature binding: ${binding.featureId}`);
    if (byId.has(binding.featureId)) throw new Error(`Duplicate feature binding: ${binding.featureId}`);
    if (binding.pending !== undefined) {
      if (binding.pending.trim() === '' || binding.topicIds.length > 0) throw new Error(`Ambiguous pending coverage: ${binding.featureId}`);
    } else if (binding.topicIds.length === 0) throw new Error(`No help topic: ${binding.featureId}`);
    if (new Set(binding.topicIds).size !== binding.topicIds.length) throw new Error(`Duplicate topic binding: ${binding.featureId}`);
    for (const topicId of binding.topicIds) if (!topicIds.has(topicId)) throw new Error(`Missing help topic: ${binding.featureId}/${topicId}`);
    byId.set(binding.featureId, binding);
  }
  for (const requirement of requirements) if (!byId.has(requirement.id)) throw new Error(`Unassigned feature: ${requirement.id}`);
  for (const binding of bindings) {
    const visited = new Set([binding.featureId]);
    let target = binding.mergedInto;
    while (target !== undefined) {
      if (visited.has(target) || !byId.has(target)) throw new Error(`Invalid merged feature: ${binding.featureId}/${target}`);
      visited.add(target); target = byId.get(target)?.mergedInto;
    }
  }
  const entries = requirements.map(requirement => {
    const binding = byId.get(requirement.id);
    if (binding === undefined) throw new Error(`Unassigned feature: ${requirement.id}`);
    return Object.freeze({ ...requirement, ...binding, topicIds: Object.freeze([...binding.topicIds]) });
  });
  return Object.freeze({ entries: Object.freeze(entries),
    pending: Object.freeze(entries.filter(entry => entry.pending !== undefined).map(entry => entry.id)), contentCertified: false as const });
}

export interface CommandHelpCoverageEntry {
  readonly commandId: string;
  readonly topicId: string;
  readonly chapterPath: string;
}

/** Command IDs come from the runtime registry, not a separately maintained expected-command list. */
export function buildCommandHelpCoverage(
  commands: readonly { readonly id: string; readonly helpTopic: string }[],
  topics: readonly { readonly id: string; readonly path: string }[],
): readonly CommandHelpCoverageEntry[] {
  if (commands.length === 0) throw new Error('No commands to document');
  const byTopic = new Map(topics.map(topic => [topic.id, topic]));
  if (byTopic.size !== topics.length) throw new Error('Duplicate help topics');
  const used = new Set<string>();
  return Object.freeze(commands.map(command => {
    if (command.id.trim() === '' || used.has(command.id)) throw new Error(`Empty or duplicate command: ${command.id}`);
    used.add(command.id);
    const topic = byTopic.get(command.helpTopic);
    if (topic === undefined) throw new Error(`Undocumented command: ${command.id}/${command.helpTopic}`);
    return Object.freeze({ commandId: command.id, topicId: topic.id, chapterPath: topic.path });
  }));
}

/** Used when producing a release; review previews can keep explicit unfinished entries. */
export function assertDocumentedFeatureCoverage(coverage: HelpFeatureCoverage): void {
  if (coverage.pending.length > 0) throw new Error(`Undocumented features: ${coverage.pending.join(', ')}`);
}
