// Landing-page interactivity. No framework — plain DOM. Direction B is a
// restrained, no-skeleton page: content paints immediately and motion is pure
// CSS (see styles/main.scss). The only JS is the waitlist funnel — hCaptcha
// render, the live count, and the double-opt-in submit — plus a reduced-motion
// guard for the count-up. All the funnel wiring below is lifted verbatim from
// the working landing so the form contract is unchanged.
import './styles/main.scss';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

initCaptcha();
initCountUp();
initNotify();
