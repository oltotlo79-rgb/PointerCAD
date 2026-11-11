import { describe, expect, it, vi } from 'vitest';
import { prepareCadBeamFrictionContact } from '@pointercad/fem';
import type * as FemModule from '@pointercad/fem';
import { contactUiFixture } from './beamContact.testSupport.js';
import { beamDefinition, editBeamSession } from './beamSession.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

vi.mock('@pointercad/fem', async importOriginal => ({ ...await importOriginal<typeof FemModule>(),
  prepareCadBeamFrictionContact: vi.fn(() => ({ marker: 'dedicated-friction-input' })) }));

describe('friction preparation', () => {
  it('passes the reviewed document, schema 7, current owner context and explicit solver options to the dedicated adapter', () => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
    session = editBeamSession(session, { kind: 'friction-coefficient', contactId: 'contact-1', source: '0.3' });
    session = editBeamSession(session, { kind: 'friction-solver', value: 'nsgs' });
    session = editBeamSession(session, { kind: 'friction-iteration-limit', source: '20000' });
    const definition = beamDefinition(session, fixture.source, []);
    if (!definition.ok || definition.definition.schema !== 'pointercad-standard-beam/7') throw new Error('schema 7 required');
    expect(prepareBeamAnalysis(fixture.source, definition.definition)).toMatchObject({ ok: true, kind: 'friction',
      input: { marker: 'dedicated-friction-input' }, solverOptions: { solver: 'nsgs', iterationLimit: 20000 } });
    expect(prepareCadBeamFrictionContact).toHaveBeenCalledWith(fixture.source.document, definition.definition,
      expect.objectContaining({ currentSource: fixture.source.source, bodies: fixture.source.ownership.bodies }));
  });
});
