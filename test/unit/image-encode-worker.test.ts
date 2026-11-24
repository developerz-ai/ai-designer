// Scheduling + transport for the encoder (`sidepanel/lib/image-encode-client.ts`): the worker
// path, the bounded queue, and the inline fallback.
//
// No real `Worker` anywhere — jsdom has none, and needing one to check a number would mean the
// split between this file and `image-encode.ts` was wrong. The fallback branch gets its own test
// because it is the branch nobody exercises by hand: it only runs when a worker fails to start.
import { describe, expect, it, vi } from 'vitest';
import type { EncodeImageResult } from '@/entrypoints/sidepanel/lib/image-encode';
import {
  createEncodeClient,
  MAX_CONCURRENT_ENCODES,
  type WorkerLike,
} from '@/entrypoints/sidepanel/lib/image-encode-client';
import type {
  EncodeRequest,
  EncodeResponse,
} from '@/entrypoints/sidepanel/lib/image-encode-protocol';

/** The one encode implementation, standing in for `image-encode.ts`. Both paths call it — which
 *  is the point: the worker moves the WORK, not the arithmetic. */
const inline = vi.fn(
  async (_blob: Blob, options: { name: string; id?: string }): Promise<EncodeImageResult> => ({
    ok: true,
    attachment: {
      kind: 'image',
      id: options.id ?? 'minted',
      name: options.name,
      mediaType: 'image/webp',
      dataUrl: 'data:image/webp;base64,AAAA',
      width: 100,
      height: 50,
    },
  }),
);

class FakeWorker implements WorkerLike {
  readonly posted: EncodeRequest[] = [];
  terminated = false;
  /** When false, jobs pile up until `flush()` — how the queue's bound is observed. */
  private readonly auto: boolean;
  private onMessage: ((event: { data: EncodeResponse }) => void) | null = null;
  private onError: (() => void) | null = null;

  constructor(auto = true) {
    this.auto = auto;
  }

  postMessage(message: EncodeRequest): void {
    this.posted.push(message);
    if (this.auto) void this.reply(message);
  }

  addEventListener(type: 'message', listener: (event: { data: EncodeResponse }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(
    type: 'message' | 'error',
    listener: ((event: { data: EncodeResponse }) => void) & (() => void),
  ): void {
    if (type === 'message') this.onMessage = listener;
    else this.onError = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  async flush(): Promise<void> {
    const queued = [...this.posted];
    this.posted.length = 0;
    for (const message of queued) await this.reply(message);
  }

  fail(): void {
    this.onError?.();
  }

  private async reply(message: EncodeRequest): Promise<void> {
    const result = await inline(message.blob, {
      name: message.name,
      ...(message.attachmentId ? { id: message.attachmentId } : {}),
    });
    this.onMessage?.({ data: { id: message.id, result } });
  }
}

const blob = (): Blob => new Blob(['bytes'], { type: 'image/png' });

describe('encode client — worker path', () => {
  it('round-trips a blob through the worker and returns its result', async () => {
    const worker = new FakeWorker();
    const client = createEncodeClient({ spawn: () => worker, inline });

    const result = await client.encode(blob(), { name: 'hero.png', id: 'fixed' });

    expect(result.ok && result.attachment.name).toBe('hero.png');
    // The blob crossed as a blob — nothing was stringified onto the boundary.
    expect(inline).toHaveBeenCalled();
  });

  it('spawns at most one worker for many encodes', async () => {
    const worker = new FakeWorker();
    const spawn = vi.fn(() => worker);
    const client = createEncodeClient({ spawn, inline });

    await Promise.all([
      client.encode(blob(), { name: 'a.png' }),
      client.encode(blob(), { name: 'b.png' }),
      client.encode(blob(), { name: 'c.png' }),
    ]);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps only a bounded number of encodes in flight', async () => {
    const worker = new FakeWorker(false);
    const client = createEncodeClient({ spawn: () => worker, inline });

    const jobs = Array.from({ length: 5 }, (_, i) => client.encode(blob(), { name: `${i}.png` }));
    await Promise.resolve();

    // Six unbounded 20MP decodes at once trades jank for a memory spike, which is not a fix.
    expect(worker.posted).toHaveLength(MAX_CONCURRENT_ENCODES);

    while (worker.posted.length > 0) await worker.flush();
    await expect(Promise.all(jobs)).resolves.toHaveLength(5);
  });
});

describe('encode client — inline fallback', () => {
  // The branch nobody exercises by hand. A user must never lose an attachment because a worker
  // did not start.
  it('produces an IDENTICAL attachment when no worker can be constructed', async () => {
    const viaWorker = await createEncodeClient({
      spawn: () => new FakeWorker(),
      inline,
    }).encode(blob(), { name: 'hero.png', id: 'fixed' });

    const viaInline = await createEncodeClient({ spawn: () => null, inline }).encode(blob(), {
      name: 'hero.png',
      id: 'fixed',
    });

    expect(viaInline).toEqual(viaWorker);
    expect(viaInline.ok).toBe(true);
  });

  it('falls back — and does not lose the attachment — when the worker errors', async () => {
    const worker = new FakeWorker(false);
    const client = createEncodeClient({ spawn: () => worker, inline });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const job = client.encode(blob(), { name: 'hero.png', id: 'fixed' });
    await Promise.resolve();
    worker.fail();

    const result = await job;

    expect(result.ok && result.attachment.name).toBe('hero.png');
    expect(worker.terminated).toBe(true);
    // Logged, not surfaced: nothing about this is the user's problem.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back when postMessage itself throws', async () => {
    const broken: WorkerLike = {
      postMessage: () => {
        throw new Error('detached');
      },
      addEventListener: () => {},
      terminate: () => {},
    };
    const client = createEncodeClient({ spawn: () => broken, inline });

    const result = await client.encode(blob(), { name: 'hero.png', id: 'fixed' });

    expect(result.ok && result.attachment.name).toBe('hero.png');
  });
});
