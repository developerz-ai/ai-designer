// Landing-page interactivity. No framework — plain DOM. All motion is gated on
// prefers-reduced-motion (the CSS also enforces this; this is the JS side).
import './styles/main.scss';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Scroll reveal ─────────────────────────────────────────────────────────────
function initReveal(): void {
  const els = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    for (const el of els) {
      el.classList.add('is-visible');
    }
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -10% 0px' },
  );
  for (const el of els) {
    observer.observe(el);
  }
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
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function initCountUp(): void {
  const el = document.getElementById('waitlist-count');
  if (!(el instanceof HTMLElement)) return;

  const target = WAITLIST_SEED + readSubmitted();
  const reveal = el.closest('[data-reveal]');
  const run = () => animateCount(el, target);

  if (prefersReducedMotion || !reveal) {
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
    { threshold: 0.5 },
  );
  observer.observe(reveal);
}

// ─── Notify form (no-backend stub → success state) ─────────────────────────────
function initNotify(): void {
  const form = document.getElementById('notify-form');
  if (!(form instanceof HTMLFormElement)) return;

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
    if (success instanceof HTMLElement) success.hidden = false;

    const count = document.getElementById('waitlist-count');
    if (count instanceof HTMLElement) count.textContent = String(WAITLIST_SEED + next);
  });
}

initReveal();
initCountUp();
initNotify();
