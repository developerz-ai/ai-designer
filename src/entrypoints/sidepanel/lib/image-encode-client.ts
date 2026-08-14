// Scheduling + transport for the image encoder. The arithmetic lives in `image-encode.ts`; this
// file decides WHERE it runs and HOW MANY run at once, and nothing else.
//
// Off the main thread, because `drawImage` is the one genuinely blocking step in an encode and the
// interaction this feature exists for — drop six mockups at once — bursts six of them (see
// `src/entrypoints/image-worker.ts`). Bounded, because six unbounded 20MP decodes in parallel
// trade jank for a memory spike, which is not an improvement.
//
// Falls back to encoding INLINE whenever the worker cannot be constructed or errors. Non-
// negotiable: a user must never lose an attachment because a worker did not start. The fallback is
// the same function the worker calls, so the produced attachment is identical either way — only
// the thread differs.

import { type EncodeImageResult, encodeImageAttachment } from './image-encode';
import {
  type EncodeRequest,
  type EncodeResponse,
  IMAGE_WORKER_FILE,
} from './image-encode-protocol';

/** How many encodes are in flight at once. Two: enough to hide the latency of a burst, small
 *  enough that two 20MP decoded surfaces are the most that ever coexist. */
export const MAX_CONCURRENT_ENCODES = 2;

/** The slice of `Worker` this client uses. Structural so a unit test can stand in for it — there
 *  is no real `Worker` under jsdom, and needing one to check a number would mean the split between
 *  this file and `image-encode.ts` was wrong. */
export interface WorkerLike {
  postMessage(message: EncodeRequest): void;
  addEventListener(type: 'message', listener: (event: { data: EncodeResponse }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  terminate(): void;
}

export interface EncodeClientDeps {
  /** Constructs the encoding worker, or returns null when the environment has none. Must not
   *  throw — `defaultClientDeps` catches for exactly this reason. */
  readonly spawn: () => WorkerLike | null;
  /** The inline path: the same encode, on this thread. */
  readonly inline: typeof encodeImageAttachment;
}

export interface EncodeClient {
  encode(blob: Blob, options: { name: string; id?: string }): Promise<EncodeImageResult>;
}

/**
 * Build an encoding client: a bounded queue in front of a lazily-spawned worker, with an inline
 * fallback. Injectable so both branches are testable without a real `Worker` or a real codec.
 */
export function createEncodeClient(deps: EncodeClientDeps = defaultClientDeps()): EncodeClient {
  // `undefined` = not tried yet, `null` = unavailable (construction failed, or it errored and was
  // retired). Lazy, so a session that never attaches an image never pays for a worker.
  let worker: WorkerLike | null | undefined;
  const pending = new Map<string, (result: EncodeImageResult) => void>();
  let inFlight = 0;
  const queue: (() => void)[] = [];

  function retire(): void {
    const dying = worker;
    worker = null;
    // Every promise still waiting on it resolves through the inline path instead of hanging —
    // a tray that spins forever is the worst possible failure here.
    const waiting = [...pending.values()];
    pending.clear();
    for (const settle of waiting) settle({ ok: false, reason: 'encode' });
    try {
      dying?.terminate();
    } catch {
      // Already dead; nothing to do.
    }
  }

  function ensureWorker(): WorkerLike | null {
    if (worker !== undefined) return worker;
    worker = deps.spawn();
    worker?.addEventListener('error', () => {
      console.warn('[designer] image worker failed; encoding on the main thread instead');
      retire();
    });
    worker?.addEventListener('message', (event) => {
      const settle = pending.get(event.data.id);
      if (!settle) return;
      pending.delete(event.data.id);
      settle(event.data.result);
    });
    return worker;
  }

  async function runOne(
    blob: Blob,
    options: { name: string; id?: string },
  ): Promise<EncodeImageResult> {
    const w = ensureWorker();
    if (!w) return deps.inline(blob, options);
    const viaWorker = await postToWorker(w, blob, options);
    // A retired worker settles its pending jobs as a plain failure; redo them inline rather than
    // telling the user their mockup could not be read.
    if (!viaWorker.ok && worker === null) return deps.inline(blob, options);
    return viaWorker;
  }

  function postToWorker(
    w: WorkerLike,
    blob: Blob,
    options: { name: string; id?: string },
  ): Promise<EncodeImageResult> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      try {
        // `blob` is structured-cloneable as-is. Nothing is stringified across this boundary.
        w.postMessage({
          id,
          blob,
          name: options.name,
          ...(options.id ? { attachmentId: options.id } : {}),
        });
      } catch {
        pending.delete(id);
        retire();
        resolve({ ok: false, reason: 'encode' });
      }
    });
  }

  function schedule(task: () => Promise<EncodeImageResult>): Promise<EncodeImageResult> {
    return new Promise((resolve) => {
      const run = (): void => {
        inFlight++;
        void task()
          .catch((): EncodeImageResult => ({ ok: false, reason: 'encode' }))
          .then((result) => {
            inFlight--;
            queue.shift()?.();
            resolve(result);
          });
      };
      if (inFlight < MAX_CONCURRENT_ENCODES) run();
      else queue.push(run);
    });
  }

  return {
    encode: (blob, options) => schedule(() => runOne(blob, options)),
  };
}

/**
 * The real deps.
 *
 * The worker is addressed by its BUILT path through `chrome.runtime.getURL`, not by
 * `new URL('./image-worker.ts', import.meta.url)`. That canonical Vite form is not merely
 * unnecessary here, it is broken under WXT and breaks SILENTLY: WXT defines
 * `import.meta.url` -> `self.location.href` for every build, Vite's `vite:define` runs before
 * `vite:worker-import-meta-url`, and that plugin only matches on the literal `import.meta.url` —
 * so no worker chunk is emitted and the `.ts` specifier survives into the bundle. The full
 * derivation is in `src/entrypoints/image-worker.ts`.
 *
 * `chrome.runtime.getURL` returns an absolute `chrome-extension://<id>/…` URL for a file the build
 * emitted: same origin, no remote fetch, no blob and no code string, so nothing here is remote
 * code and nothing trips Trusted Types.
 *
 * CLASSIC worker, deliberately: WXT builds unlisted scripts as a self-contained IIFE, so there is
 * no module graph to load and `{ type: 'module' }` would fail.
 */
export function defaultClientDeps(): EncodeClientDeps {
  return {
    spawn: () => {
      try {
        return new Worker(chrome.runtime.getURL(`/${IMAGE_WORKER_FILE}`)) as unknown as WorkerLike;
      } catch (err) {
        console.warn('[designer] image worker unavailable; encoding on the main thread', err);
        return null;
      }
    },
    inline: encodeImageAttachment,
  };
}

const client = createEncodeClient();

/** Encode one image through the shared queue. What `stores/attachments.ts` calls. */
export function queueImageEncode(
  blob: Blob,
  options: { name: string; id?: string },
): Promise<EncodeImageResult> {
  return client.encode(blob, options);
}
