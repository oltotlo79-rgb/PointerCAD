/**
 * Let messages and already queued cancellation timers run between CAD steps.
 * A timer scheduled from a MessagePort task starts with nesting level zero;
 * repeated CAD steps therefore do not accumulate the browser's 4ms timer floor.
 * The timer is still awaited, so cancellation timers are not replaced by a
 * chain of microtasks or by a MessageChannel-only continuation.
 * https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers
 */
export function yieldToMessages(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise(resolve => { setTimeout(resolve, 0); });
  }
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => {
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      channel.port2.close();
    };
    channel.port1.onmessage = () => {
      close();
      setTimeout(resolve, 0);
    };
    channel.port1.onmessageerror = () => {
      close();
      reject(new Error('The CAD task queue could not receive its message.'));
    };
    try { channel.port2.postMessage(null); }
    catch (error) {
      close();
      reject(error instanceof Error ? error : new Error('The CAD task queue could not send its message.', { cause: error }));
    }
  });
}
