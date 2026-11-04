import type { Request, Response } from 'express';
import type { StreamEvent, RunStatus } from '@career/contracts';
// Receive functions, rather than business modules, to keep platform independent of the domain.
export function streamEvents(
  req: Request,
  res: Response,
  options: {
    after: number;
    read: (after: number) => StreamEvent[];
    status: () => RunStatus;
    subscribe: (listener: () => void) => () => void;
    authorized?: () => boolean;
    onInvalidated?: (listener: () => void) => () => void;
  },
) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let last = options.after;
  let closed = false;
  let pumping = false;
  let dirty = false;
  let unsubscribeInvalidation = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeInvalidation();
    clearInterval(heartbeat);
  };
  const pump = () => {
    if (closed) return;
    if (options.authorized && !options.authorized()) {
      cleanup();
      res.end();
      return;
    }
    if (pumping) {
      dirty = true;
      return;
    }
    pumping = true;
    try {
      do {
        dirty = false;
        for (const event of options.read(last)) {
          last = event.sequence;
          if (
            !res.write(
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
          )
            break;
        }
      } while (dirty && !closed);
      if (!['queued', 'running', 'cancelling'].includes(options.status())) {
        const remaining = options.read(last);
        if (remaining.length) {
          dirty = true;
          queueMicrotask(pump);
        } else {
          cleanup();
          res.end();
        }
      }
    } finally {
      pumping = false;
    }
  };
  const unsubscribe = options.subscribe(pump);
  const heartbeat = setInterval(() => {
    if (options.authorized && !options.authorized()) {
      cleanup();
      res.end();
    } else if (!closed) res.write(': keepalive\n\n');
  }, 15000);
  unsubscribeInvalidation =
    options.onInvalidated?.(() => {
      cleanup();
      res.end();
    }) ?? (() => {});
  res.on('drain', pump);
  res.on('close', cleanup);
  pump();
}
