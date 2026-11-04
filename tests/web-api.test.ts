import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, post, RequestError, accountClient } from '../apps/web/src/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('usable JSON response boundary', () => {
  it('binds delayed requests to the original account rather than a changed browser identity', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    vi.stubGlobal('fetch', fetch);
    const alice = accountClient('alice');
    const bob = accountClient('bob');
    await bob.post('/conversations');
    await alice.post('/conversations');
    expect(fetch.mock.calls[0][1].headers['X-Career-Account']).toBe('bob');
    expect(fetch.mock.calls[1][1].headers['X-Career-Account']).toBe('alice');
  });
  it.each(['{"messageId":', 'null', '[]', '"accepted"'])(
    'keeps write ambiguity for unusable successful JSON %s',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 202 })));
      await expect(
        post('/messages', { clientRequestId: 'original-id', text: 'original text' }),
      ).rejects.toMatchObject({
        ambiguous: true,
        retryable: true,
      });
    },
  );

  it('keeps write ambiguity when a successful response body stream breaks', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('truncated'));
        },
      }),
      { status: 202 },
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(post('/messages')).rejects.toMatchObject({ ambiguous: true, retryable: true });
  });

  it('reports an unusable successful GET body without write ambiguity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null')));
    await expect(api('/conversations')).rejects.toMatchObject({
      ambiguous: false,
      retryable: true,
    });
  });

  it('returns valid objects and preserves server error metadata', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ messageId: 'message', runId: 'run' }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ message: 'Conflict', retryable: false }, { status: 409 }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(post('/messages')).resolves.toEqual({ messageId: 'message', runId: 'run' });
    await expect(post('/messages')).rejects.toEqual(new RequestError('Conflict', false, false));
  });
});
