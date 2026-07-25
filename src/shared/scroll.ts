// Shared timing constants for the scroll→capture choreography (#137 item 5 — the two
// entrypoint copies of this const were kept in sync by comment; hoist the ONE source here).
// Pure constants: safe to import from every world (SW, content, panel).

/** Let the page paint after a programmatic scroll before grabbing pixels — captureVisibleTab
 *  reads the composited surface, so an un-settled scroll would grab pre-scroll pixels. On a
 *  `scroll-behavior: smooth` page the scroll animates, so the settle is best-effort there. */
export const SCROLL_SETTLE_MS = 200;
