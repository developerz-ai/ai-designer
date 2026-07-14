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
  // Native scroll-driven animations (Chrome/Safari) handle these in CSS.
  if (CSS.supports('animation-timeline: view()')) {
    return;
  }
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

initSkeleton();
initCountUp();
initNotify();
initReveal();
initSpotlight();
