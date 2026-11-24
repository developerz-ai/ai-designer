import type { FilePart } from 'ai';

// The ONE place a screenshot/image becomes a model-message part (#182). AI SDK 7 deprecated
// `{type:'image'}`; a `file` part with an explicit image mediaType lowers to the same provider
// part without the per-part DeprecationWarning. Every producer (vision sub-calls, the report
// builder, user attachments) goes through here or states its mediaType itself — a divergence
// between the sites is worse than the warning, which is why the migration is one module.

/** `data:` URL mediaType, e.g. `data:image/png;base64,…` → `image/png`. */
const DATA_URL_MEDIA = /^data:([^;,]+)[;,]/;

/** Build an image `file` part from an inline `data:` URL. The mediaType is read off the URL
 *  itself; PNG — the only format this extension captures (`captureVisibleTab` format:'png') —
 *  is the fallback for a bare payload. */
export function imageFilePart(data: string, fallback = 'image/png'): FilePart {
  return { type: 'file', data, mediaType: DATA_URL_MEDIA.exec(data)?.[1] ?? fallback };
}
