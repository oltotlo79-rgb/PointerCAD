/** Notation changes use the same cancellable queue and immutable document snapshot as evaluation. */
import { sameMathIdentity, type MathWorkerClient, type MathWorkRequest } from '@pointercad/expression/math/client';
import type { MathEditorInput } from './mathEditorSession.js';

export async function convertMathSessionNotation(client: MathWorkerClient, input: MathEditorInput,
  request: MathWorkRequest, target: 'text' | 'latex', signal: AbortSignal): Promise<string> {
  if (!sameMathIdentity(input.identity, request.identity) || input.source !== request.source
    || input.notation !== request.notation || input.angleUnit !== request.angleUnit) throw new Error('The math input changed before conversion');
  const completion = await client.evaluate({ ...request, presentationNotation: target }, 5_000, signal);
  if (completion.status !== 'result') throw new Error(`Math notation conversion stopped: ${completion.status}`);
  const converted = completion.result.presentation;
  if (!sameMathIdentity(completion.identity, input.identity) || converted === undefined || converted === null
    || converted.inputNotation !== target || converted.angleUnit !== input.angleUnit) throw new Error('Math notation conversion did not return the requested input');
  return converted.source;
}
