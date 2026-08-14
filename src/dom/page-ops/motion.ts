// Motion control — the operations that make a page hold still long enough to be looked at, and let
// an agent verify a transition actually ran.
//
// A design agent screenshots constantly. On a page with a carousel, a marquee, a spinner or an
// entrance animation, two screenshots of an unchanged page differ, and the agent concludes its edit
// did something. Freezing motion is not a nicety; it is what makes visual verification mean
// anything. Everything here is reversible and page-local. Pure DOM + injected document.

import { SHEET_ATTR } from '@/dom/mutate';

export interface AnimationInfo {
  readonly name: string;
  /** `running` | `paused` | `finished` | `idle`. */
  readonly state: string;
  readonly durationMs: number | null;
  /** True for a CSS transition rather than a keyframe animation. */
  readonly isTransition: boolean;
}

/** Every animation and transition currently live in a subtree — what is moving, and for how long.
 *  Uses the Web Animations API, which reports CSS animations, CSS transitions and JS animations
 *  alike; a host without it reports nothing rather than throwing. */
export function listAnimations(root: Element | Document): AnimationInfo[] {
  const host = root as { getAnimations?: (opts?: { subtree?: boolean }) => Animation[] };
  if (typeof host.getAnimations !== 'function') return [];
  let animations: Animation[];
  try {
    animations = host.getAnimations({ subtree: true });
  } catch {
    return [];
  }
  return animations.map((a) => {
    const effect = a.effect;
    const timing = effect?.getComputedTiming?.();
    const duration = typeof timing?.duration === 'number' ? timing.duration : null;
    return {
      name: describeAnimation(a),
      state: a.playState,
      durationMs: duration,
      isTransition: typeof (a as { transitionProperty?: unknown }).transitionProperty === 'string',
    };
  });
}

function describeAnimation(a: Animation): string {
  const named = a as { animationName?: unknown; transitionProperty?: unknown };
  if (typeof named.animationName === 'string' && named.animationName) return named.animationName;
  if (typeof named.transitionProperty === 'string' && named.transitionProperty) {
    return `transition: ${named.transitionProperty}`;
  }
  return a.id || 'animation';
}

/** The id of the stylesheet the freeze installs — named so `injectCss` semantics apply (a second
 *  freeze replaces it) and so an overhaul stylesheet can never be mistaken for it. */
export const FREEZE_SHEET_ID = 'dz-freeze-motion';

const FREEZE_CSS = [
  '*, *::before, *::after {',
  '  animation-play-state: paused !important;',
  '  animation-delay: -1ms !important;',
  '  animation-duration: 1ms !important;',
  '  animation-iteration-count: 1 !important;',
  '  transition-duration: 0ms !important;',
  '  transition-delay: 0ms !important;',
  '  scroll-behavior: auto !important;',
  '}',
].join('\n');

export interface FreezeResult {
  readonly frozen: boolean;
  /** How many live animations were paused outright (CSS alone cannot stop a JS animation). */
  readonly paused: number;
}

/**
 * Hold the page still — or let it go again. Two mechanisms, because one is not enough: a stylesheet
 * pins CSS animations and collapses transitions, and the Web Animations API pauses everything else
 * (a JS-driven animation ignores `animation-play-state` entirely).
 *
 * Reversible: releasing removes the sheet and plays every animation the freeze paused.
 */
export function freezeMotion(doc: Document, frozen: boolean): FreezeResult {
  const existing = doc.querySelector(`style[${SHEET_ATTR}="${FREEZE_SHEET_ID}"]`);
  const host = doc as unknown as { getAnimations?: () => Animation[] };
  const animations = typeof host.getAnimations === 'function' ? safeAnimations(host) : [];

  if (!frozen) {
    existing?.remove();
    let resumed = 0;
    for (const a of animations) {
      if (a.playState !== 'paused') continue;
      try {
        a.play();
        resumed += 1;
      } catch {
        // A finished or detached animation refuses to play; nothing to restore.
      }
    }
    return { frozen: false, paused: resumed };
  }

  if (!existing) {
    const style = doc.createElement('style');
    style.setAttribute(SHEET_ATTR, FREEZE_SHEET_ID);
    style.textContent = FREEZE_CSS;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  let paused = 0;
  for (const a of animations) {
    if (a.playState !== 'running') continue;
    try {
      a.pause();
      paused += 1;
    } catch {
      // Some animations cannot be paused (a finished one); the stylesheet still covers CSS motion.
    }
  }
  return { frozen: true, paused };
}

function safeAnimations(host: { getAnimations?: () => Animation[] }): Animation[] {
  try {
    return host.getAnimations?.() ?? [];
  } catch {
    return [];
  }
}

export interface MediaResult {
  readonly paused: boolean;
  readonly muted: boolean;
  readonly currentTime: number;
  readonly duration: number | null;
}

/** Drive a `<video>`/`<audio>` — pause it for a screenshot, seek it to a representative frame,
 *  mute it before it startles the user. Anything that is not a media element is refused by the
 *  caller; this returns `null` for a non-media target rather than guessing. */
export function controlMedia(
  el: Element,
  action: 'pause' | 'play' | 'mute' | 'unmute' | 'seek',
  time?: number,
): MediaResult | null {
  const media = el as HTMLMediaElement;
  if (typeof media.play !== 'function' || typeof media.pause !== 'function') return null;
  switch (action) {
    case 'pause':
      media.pause();
      break;
    case 'play':
      // A rejected play() (autoplay policy) must not throw into the turn — the state read below
      // reports what actually happened.
      void Promise.resolve(media.play()).catch(() => {});
      break;
    case 'mute':
      media.muted = true;
      break;
    case 'unmute':
      media.muted = false;
      break;
    case 'seek':
      if (typeof time === 'number') media.currentTime = time;
      break;
  }
  return {
    paused: media.paused,
    muted: media.muted,
    currentTime: media.currentTime,
    duration: Number.isFinite(media.duration) ? media.duration : null,
  };
}
