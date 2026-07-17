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

// ─── hCaptcha ─────────────────────────────────────────────────────────────────
// The site key is public. Build-time env override with the documented hCaptcha
// TEST key as the fallback (the real production key is a deploy-time precondition).
// `||` (not `??`): a Docker ARG that was never passed arrives as an EMPTY string,
// which must also fall back to the test key rather than render a broken widget.
const HCAPTCHA_SITEKEY =
  import.meta.env.VITE_HCAPTCHA_SITEKEY || '10000000-ffff-ffff-ffff-000000000001';

let captchaWidgetId: string | undefined;

// api.js is loaded with ?render=explicit, so we render the widget ourselves once
// the global is ready. Poll, because the async script may resolve after this
// module has already run.
function initCaptcha(): void {
  const container = document.getElementById('notify-captcha');
  if (!container) {
    return;
  }
  let attempts = 0;
  const tryRender = (): void => {
    const hcaptcha = window.hcaptcha;
    if (hcaptcha?.render) {
      captchaWidgetId = hcaptcha.render(container, {
        sitekey: HCAPTCHA_SITEKEY,
        theme: 'dark',
      });
      return;
    }
    if (attempts++ < 50) {
      window.setTimeout(tryRender, 100);
    }
  };
  tryRender();
}

function captchaToken(): string {
  const hcaptcha = window.hcaptcha;
  if (!hcaptcha?.getResponse) {
    return '';
  }
  try {
    return hcaptcha.getResponse(captchaWidgetId);
  } catch {
    return '';
  }
}

function resetCaptcha(): void {
  try {
    window.hcaptcha?.reset(captchaWidgetId);
  } catch {
    // hCaptcha not ready — nothing to reset.
  }
}

// ─── Waitlist count-up (live count from the waitlist service) ──────────────────
// Sane floor so the band never reads a bare "0" when the count endpoint is
// unreachable (e.g. the static site loaded before the backend is up). Kept in
// sync with the waitlist service's WAITLIST_SEED_COUNT default so the fallback
// matches the seeded live number instead of jumping to an unrelated value.
const COUNT_FLOOR = 134;

async function fetchCount(): Promise<number> {
  try {
    const res = await fetch('/waitlist/count', { headers: { accept: 'application/json' } });
    if (!res.ok) {
      return COUNT_FLOOR;
    }
    const data = (await res.json()) as { count?: unknown };
    const n = typeof data.count === 'number' ? data.count : Number(data.count);
    return Number.isFinite(n) && n >= 0 ? n : COUNT_FLOOR;
  } catch {
    return COUNT_FLOOR;
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

  const countPromise = fetchCount();
  const run = () => {
    void countPromise.then((target) => animateCount(el, target));
  };

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

// ─── Notify form (double opt-in → real waitlist service) ───────────────────────
function showSuccess(form: HTMLFormElement, message: string): void {
  form.hidden = true;
  const error = document.getElementById('notify-error');
  if (error instanceof HTMLElement) {
    error.hidden = true;
  }
  const success = document.getElementById('notify-success');
  if (success instanceof HTMLElement) {
    success.textContent = message;
    success.hidden = false;
  }
}

function showError(message: string): void {
  const error = document.getElementById('notify-error');
  if (error instanceof HTMLElement) {
    error.textContent = message;
    error.hidden = false;
  }
}

async function submitEmail(
  form: HTMLFormElement,
  email: string,
  token: string,
  submit: HTMLButtonElement | null,
): Promise<void> {
  if (submit) {
    submit.disabled = true;
  }
  try {
    const res = await fetch('/waitlist/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, captchaToken: token, consent: 'true' }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (res.ok && data?.ok === true) {
      showSuccess(form, 'Check your email to confirm');
      return;
    }
    showError('Something went wrong. Please try again.');
  } catch {
    showError('Network error. Please try again.');
  } finally {
    if (submit) {
      submit.disabled = false;
    }
    resetCaptcha();
  }
}

function initNotify(): void {
  const form = document.getElementById('notify-form');
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  // Double opt-in completed: the confirm link redirects here with ?subscribed=1.
  if (new URLSearchParams(window.location.search).get('subscribed') === '1') {
    showSuccess(form, "You're subscribed — we'll email you at launch.");
    return;
  }

  const field = form.querySelector<HTMLInputElement>('input[name="email"]');
  const consent = document.getElementById('notify-consent');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!field) {
      return;
    }
    if (field.value.trim() === '' || !field.checkValidity()) {
      // novalidate is set, so the browser won't surface why on its own.
      field.reportValidity();
      field.focus();
      return;
    }
    if (!(consent instanceof HTMLInputElement) || !consent.checked) {
      showError('Please agree to be emailed at launch.');
      if (consent instanceof HTMLElement) {
        consent.focus();
      }
      return;
    }
    const token = captchaToken();
    if (token === '') {
      showError('Please complete the captcha.');
      return;
    }

    void submitEmail(form, field.value.trim(), token, submit);
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
initCaptcha();
initCountUp();
initNotify();
initReveal();
initSpotlight();
initNavScroll();
initNavActiveLink();
initHeroCard();
