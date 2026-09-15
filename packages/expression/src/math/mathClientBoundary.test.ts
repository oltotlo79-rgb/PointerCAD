import { expect, it, vi } from 'vitest';

// These modules can only execute inside the calculation Worker. Fail during
// import, before a client can accidentally pull their code into the UI bundle.
vi.mock('./createMathBackend.js', () => {
  throw new Error('The editor client imported the symbolic calculation backend.');
});
vi.mock('./compileFunctionScalar.js', () => {
  throw new Error('The editor client imported the function calculation compiler.');
});
vi.mock('./continueImplicitFunctionPoint.js', () => {
  throw new Error('The editor client imported the point continuation calculation.');
});

vi.mock('./exactLinearOperations.js', () => {
  throw new Error('The editor metadata imported the exactLinearOperations calculation.');
});
vi.mock('./statisticsOperations.js', () => {
  throw new Error('The editor metadata imported the statisticsOperations calculation.');
});
vi.mock('./tensorOperations.js', () => {
  throw new Error('The editor metadata imported the tensorOperations calculation.');
});
vi.mock('./integerMathOperations.js', () => {
  throw new Error('The editor metadata imported the integerMathOperations calculation.');
});

it('数式と全関数の画面側通信を読み込んでもWorker専用の計算処理を読み込まない', async () => {
  const clients = await Promise.all([
    import('./publicContracts.js'),
    import('./publicClient.js'),
  ]);
  for (const client of clients) expect(Object.keys(client).length).toBeGreaterThan(0);
});
