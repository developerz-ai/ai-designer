// Landing-page interactivity. No framework — plain DOM. All motion is gated on
// prefers-reduced-motion (the CSS also enforces this; this is the JS side).
import './styles/main.scss';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Skeleton → content reveal ────────────────────────────────────────────────
// The inline head script adds .is-loading before paint (hides content, shows
// skeletons). Once the page is loaded we wait a short dwell so the skeletons
// are perceived, fade them out (.is-leaving), then drop .is-loading so the real
// content appears (with the skel-reveal entrance from _skeleton.scss).
function initSkeleton(): void {
  const html = document.documentElement;
  if (!html.classList.contains('is-loading')) {
    return;
  }

  let revealed = false;
  const reveal = () => {
    if (revealed) {
      return;
    }
    revealed = true;
    html.classList.add('is-leaving');
    window.setTimeout(() => {
      html.classList.remove('is-loading');
      html.classList.remove('is-leaving');
    }, 180);
  };

  const dwell = prefersReducedMotion ? 0 : 450;
  if (document.readyState === 'complete') {
    window.setTimeout(reveal, dwell);
  } else {
    window.addEventListener('load', () => window.setTimeout(reveal, dwell), { once: true });
  }
  // Fallback in case the load event is delayed or never fires.
  window.setTimeout(reveal, dwell + 2000);
}

// ─── Waitlist count-up (no-backend demo) ───────────────────────────────────────
const WAITLIST_SEED = 1283;
const STORAGE_KEY = 'dz-designer-waitlist';

function readSubmitted(): number {
  try {
    return Number(localStorage.getItem(STORAGE_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function writeSubmitted(n: number): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
    return true;
  } catch {
    return false;
  }
}

function animateCount(el: HTMLElement, to: number): void {
  if (prefersReducedMotion) {
    el.textContent = String(to);
    return;
  }
  const duration = 1400;
  const start = performance.now();
  const tick = (now: number) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - progress) ** 3; // easeOutCubic
    el.textContent = String(Math.round(to * eased));
    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

function initCountUp(): void {
  const el = document.getElementById('waitlist-count');
  if (!(el instanceof HTMLElement)) {
    return;
  }

  const target = WAITLIST_SEED + readSubmitted();
  const run = () => animateCount(el, target);

  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    run();
    return;
  }
  const section = document.getElementById('notify');
  if (!section) {
    run();
    return;
  }
  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          run();
          obs.disconnect();
        }
      }
    },
    { threshold: 0.4 },
  );
  observer.observe(section);
}

// ─── Notify form (no-backend stub → success state) ─────────────────────────────
function initNotify(): void {
  const form = document.getElementById('notify-form');
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  const success = document.getElementById('notify-success');
  const field = form.querySelector<HTMLInputElement>('input[name="email"]');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!field) {
      return;
    }
    if (field.value.trim() === '' || !field.checkValidity()) {
      field.focus();
      return;
    }
    const next = readSubmitted() + 1;
    writeSubmitted(next);

    form.hidden = true;
    if (success instanceof HTMLElement) {
      success.hidden = false;
    }

    const count = document.getElementById('waitlist-count');
    if (count instanceof HTMLElement) {
      count.textContent = String(WAITLIST_SEED + next);
    }
  });
}

// ─── Scroll reveal (IO fallback; native animation-timeline handles the rest) ──
function initReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (targets.length === 0) {
    return;
  }
  // IntersectionObserver is the single reveal driver: it fires immediately for
  // anything already in view, so content can never strand hidden. (The native
  // animation-timeline path was removed because it strands the last element,
  // which can't be scrolled past its reveal range.)
  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => {
      el.classList.add('is-visible');
    });
    return;
  }
  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
  );
  targets.forEach((el) => {
    observer.observe(el);
  });
}

// ─── Card cursor-spotlight (brand radial follows the pointer) ─────────────────
function initSpotlight(): void {
  if (prefersReducedMotion) {
    return;
  }
  const cards = document.querySelectorAll<HTMLElement>('.how__card');
  cards.forEach((card) => {
    let rafId = 0;
    card.addEventListener('pointermove', (event) => {
      if (rafId) {
        return;
      }
      rafId = requestAnimationFrame(() => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
        card.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
        rafId = 0;
      });
    });
    card.addEventListener('pointerleave', () => {
      card.style.removeProperty('--mx');
      card.style.removeProperty('--my');
    });
  });
}

// ─── Nav: scroll-aware condense + scroll-spy active link ─────────────────────
function initNavScroll(): void {
  const nav = document.querySelector('.nav');
  if (!nav) {
    return;
  }
  let ticking = false;
  const onScroll = () => {
    if (ticking) {
      return;
    }
    ticking = true;
    requestAnimationFrame(() => {
      nav.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function initNavActiveLink(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.nav__link'));
  if (links.length === 0 || !('IntersectionObserver' in window)) {
    return;
  }
  const map = new Map<string, HTMLAnchorElement>();
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href?.startsWith('#')) {
      const section = document.querySelector(href);
      if (section?.id) {
        map.set(section.id, link);
      }
    }
  }
  if (map.size === 0) {
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        for (const link of links) {
          link.classList.remove('is-active');
        }
        const active = map.get(entry.target.id);
        if (active) {
          active.classList.add('is-active');
        }
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  for (const id of map.keys()) {
    const section = document.getElementById(id);
    if (section) {
      observer.observe(section);
    }
  }
}

// ─── Hero card demo loop (decorative; the card is aria-hidden) ───────────────
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitForReveal(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!document.documentElement.classList.contains('is-loading')) {
        resolve();
        return;
      }
      window.setTimeout(check, 80);
    };
    check();
  });
}

function initHeroCard(): void {
  if (prefersReducedMotion) {
    return;
  }
  const card = document.querySelector<HTMLElement>('.hero__card');
  if (!card) {
    return;
  }
  // Hide the animated parts up front, before the skeleton reveal shows the card.
  card.classList.add('is-active');

  const bubbles = Array.from(card.querySelectorAll<HTMLElement>('.chat__bubble'));
  const diffLines = Array.from(card.querySelectorAll<HTMLElement>('.diff code > span'));
  const chips = Array.from(card.querySelectorAll<HTMLElement>('.chip'));

  const run = async (): Promise<void> => {
    if (document.documentElement.classList.contains('is-loading')) {
      await waitForReveal();
    }
    await sleep(200);

    // 1. user bubble pops in.
    bubbles[0]?.classList.add('is-shown');
    await sleep(500);

    // 2. agent bubble types in char-by-char with a blinking caret.
    const agent = bubbles[1];
    if (agent) {
      const full = agent.textContent ?? '';
      agent.textContent = '';
      agent.classList.add('is-shown', 'is-typing');
      await sleep(120);
      for (let i = 0; i < full.length; i++) {
        agent.textContent = full.slice(0, i + 1);
        await sleep(22);
      }
      agent.classList.remove('is-typing');
    }
    await sleep(220);

    // 3. diff lines fade in, staggered.
    for (const line of diffLines) {
      line.classList.add('is-shown');
      await sleep(90);
    }
    await sleep(160);

    // 4. chips pop.
    for (const chip of chips) {
      chip.classList.add('is-shown');
      await sleep(80);
    }
  };

  void run();
}

initSkeleton();
initCountUp();
initNotify();
initReveal();
initSpotlight();
initNavScroll();
initNavActiveLink();
initHeroCard();
