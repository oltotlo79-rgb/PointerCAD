import { writeFile } from 'node:fs/promises';
import type { CDPSession, Page, TestInfo } from '@playwright/test';

/** 明示した診断だけで、読込済みの計算Workerと画面を同じ操作の間に測る。 */
export async function startDrawingCpuProfile(page: Page, info: TestInfo,
  prefix: 'drawing-opening' | 'history-startup' | 'interference-warm' = 'drawing-opening',
): Promise<() => Promise<void>> {
  if (process.env.POINTERCAD_DRAWING_CPU_PROFILE !== '1') return async () => {};
  if (page.workers().length === 0) await page.waitForEvent('worker', { timeout: 10_000 });
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
  const workers: { sessionId: string; url: string }[] = [];
  try {
    const { targetInfo: pageTarget } = await session.send('Target.getTargetInfo');
    if (pageTarget.browserContextId === undefined) throw new Error('CPU profile page context is unavailable.');
    const { targetInfos } = await session.send('Target.getTargets');
    for (const target of targetInfos.filter((target) => target.type === 'worker'
      && target.browserContextId === pageTarget.browserContextId && workerUrls.has(target.url))) {
      const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      workers.push({ sessionId, url: target.url });
      await workerCommand(sessionId, 'Profiler.enable');
      await workerCommand(sessionId, 'Profiler.start');
    }
    if (workers.length === 0) throw new Error('CPU診断の計算Workerが見つかりません。');
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
  } catch (error) { await detach(session, workers); throw error; }
  let stopped: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const windowTimerStartedAt = Date.now();
  const collect = async (): Promise<void> => {
    try {
      const results = await Promise.allSettled([
        (async () => {
          const main = await session.send('Profiler.stop');
          await writeFile(info.outputPath(`${prefix}-page.cpuprofile`), JSON.stringify(main.profile));
        })(),
        ...workers.map(async (worker, index) => {
          const result = await workerCommand(worker.sessionId, 'Profiler.stop');
          if (typeof result !== 'object' || result === null || !('profile' in result)) {
            throw new Error('Worker CPU profile was not returned.');
          }
          await writeFile(info.outputPath(`${prefix}-worker-${index}.cpuprofile`), JSON.stringify(result.profile));
        }),
      ]);
      await writeFile(info.outputPath(`${prefix}-workers.json`), JSON.stringify(workers, null, 2));
      const failures = results.flatMap(result => result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
      await writeFile(info.outputPath(`${prefix}-collection.json`), JSON.stringify({ failures,
        partial: prefix === 'interference-warm', plannedWindowMs: prefix === 'interference-warm' ? 15_000 : null,
        windowTimerStartedAt: new Date(windowTimerStartedAt).toISOString(), collectionFinishedAt: new Date().toISOString(),
      }, null, 2));
      if (failures.length > 0) throw new AggregateError(failures, 'CPU profile collection failed.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await detach(session, workers);
    }
  };
  const stop = (): Promise<void> => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    stopped ??= collect();
    return stopped;
  };
  if (prefix === 'interference-warm') {
    timer = setTimeout(() => {
      // Keep the same rejected promise for the caller's finally; handle its background rejection now.
      void stop().catch((error: unknown) => { console.error('[partial CPU profile collection failed]', error); });
    }, 15_000);
  }
  return stop;
}

async function detach(session: CDPSession, workers: readonly { sessionId: string }[]): Promise<void> {
  try {
    const results = await Promise.allSettled(workers.map(worker =>
      session.send('Target.detachFromTarget', { sessionId: worker.sessionId })));
    const failures = results.flatMap(result => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'Worker profiler detach failed.');
  } finally { await session.detach(); }
}
