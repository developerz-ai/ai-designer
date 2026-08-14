// The panel <-> encode-worker wire, and the encode itself. Shared by both ends: the worker
// entrypoint (`src/entrypoints/image-worker.ts`) and the client that posts to it
// (`image-encode-client.ts`). Neither end owns the protocol, so it lives here rather than in
// either of them.
//
// Why this module exists at all instead of the worker file exporting its own types: the worker is
// a WXT ENTRYPOINT, and an entrypoint is a build target, not a library. Importing anything from it
// — even a type — invites someone to import a value from it later and pull a second copy of the
// encoder into the panel chunk.

import { type EncodeImageResult, encodeImageAttachment } from './image-encode';

/**
 * Where WXT emits the built worker, relative to the extension root.
 *
 * This is `<entrypoint name>.js` for an unlisted script, and it is derived, not guessed:
 * `wxt/dist/core/utils/building/find-entrypoints.mjs` maps `entrypoints/*.ts` to `unlisted-script`
 * with `outputDir: wxt.config.outDir`, and `getEntrypointOutputFile` resolves
 * `<outputDir>/<name><ext>`. So `src/entrypoints/image-worker.ts` builds to `/image-worker.js`.
 *
 * `test/unit/image-encode-bundling.test.ts` asserts the source file and this constant agree, and —
 * when a build is present — that the file is actually in it.
 */
export const IMAGE_WORKER_FILE = 'image-worker.js';

/** One encode job. `blob` is structured-cloneable as-is — nothing is stringified across this
 *  boundary, which is the point of using a worker rather than a data-URL round trip. */
export interface EncodeRequest {
  /** Correlates the reply; the client keeps one pending promise per id. */
  readonly id: string;
  readonly blob: Blob;
  readonly name: string;
  /** The attachment id the store already minted, so the tray's key survives the round trip. */
  readonly attachmentId?: string;
}

export interface EncodeResponse {
  readonly id: string;
  readonly result: EncodeImageResult;
}

/**
 * Run one request. Lives here rather than in the worker entrypoint so it is reachable from a unit
 * test without a `Worker`, and so the worker file stays what it should be: transport.
 *
 * Never rejects — a silent worker is a tray that spins forever.
 */
export async function runEncodeRequest(request: EncodeRequest): Promise<EncodeResponse> {
  let result: EncodeImageResult;
  try {
    result = await encodeImageAttachment(request.blob, {
      name: request.name,
      ...(request.attachmentId ? { id: request.attachmentId } : {}),
    });
  } catch {
    // `encodeImageAttachment` is contracted not to throw. If it ever does, the client must still
    // get an answer.
    result = { ok: false, reason: 'encode' };
  }
  return { id: request.id, result };
}
