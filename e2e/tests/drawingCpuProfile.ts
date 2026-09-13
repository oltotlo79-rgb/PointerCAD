import { writeFile } from 'node:fs/promises';
import type { CDPSession, Page, TestInfo } from '@playwright/test';

/** 明示した診断だけで、読込済みの計算Workerと画面を同じ操作の間に測る。 */
export async function startDrawingCpuProfile(page: Page, info: TestInfo): Promise<() => Promise<void>> {
  if (process.env.POINTERCAD_DRAWING_CPU_PROFILE !== '1') return async () => {};
  const session = await page.context().newCDPSession(page);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let serial = 0;
  session.on('Target.receivedMessageFromTarget', ({ message }) => {
    const reply: unknown = JSON.parse(message);
    if (typeof reply !== 'object' || reply === null || !('id' in reply) || typeof reply.id !== 'number') return;
    const request = pending.get(reply.id);
    if (request === undefined) return;
    pending.delete(reply.id);
    if ('error' in reply) request.reject(new Error(JSON.stringify(reply.error)));
    else request.resolve('result' in reply ? reply.result : undefined);
  });
  const workerCommand = (sessionId: string, method: string): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CPU診断の応答なし: ${method}`)); }, 10_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    void session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch((error: unknown) => {
      pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))); pending.delete(id);
    });
  });
  const workerUrls = new Set(page.workers().map((worker) => worker.url()));
  const { targetInfos } = await session.send('Target.getTargets');
  const workers: { sessionId: string; url: string }[] = [];
  try {
    for (const target of targetInfos.filter((target) => target.type === 'worker' && workerUrls.has(target.url))) {
      const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      workers.push({ sessionId, url: target.url });
      await workerCommand(sessionId, 'Profiler.enable');
      await workerCommand(sessionId, 'Profiler.start');
    }
    if (workers.length === 0) throw new Error('CPU診断の計算Workerが見つかりません。');
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
  } catch (error) { await detach(session, workers); throw error; }
  return async () => {
    try {
      const main = await session.send('Profiler.stop');
      await writeFile(info.outputPath('drawing-opening-page.cpuprofile'), JSON.stringify(main.profile));
      for (const [index, worker] of workers.entries()) {
        const result = await workerCommand(worker.sessionId, 'Profiler.stop');
        if (typeof result !== 'object' || result === null || !('profile' in result)) throw new Error('CPU診断の記録がありません。');
        await writeFile(info.outputPath(`drawing-opening-worker-${index}.cpuprofile`), JSON.stringify(result.profile));
      }
      await writeFile(info.outputPath('drawing-opening-workers.json'), JSON.stringify(workers, null, 2));
    } finally { await detach(session, workers); }
  };
}

async function detach(session: CDPSession, workers: readonly { sessionId: string }[]): Promise<void> {
  try {
    for (const worker of workers) await session.send('Target.detachFromTarget', { sessionId: worker.sessionId });
  } finally { await session.detach(); }
}
