/// <reference types="vite/client" />

// Side-effect SCSS imports (import './styles/main.scss') need an ambient module
// declaration for tsc; vite/client covers most asset types but not bare .scss.
declare module '*.scss';

// Build-time env (Vite `import.meta.env`). The waitlist hCaptcha site key is
// injected here; defaults to the documented hCaptcha TEST key in main.ts.
interface ImportMetaEnv {
  readonly VITE_HCAPTCHA_SITEKEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// hCaptcha JS API (loaded from js.hcaptcha.com with ?render=explicit).
interface HCaptcha {
  render(container: string | HTMLElement, params: { sitekey: string; theme?: string }): string;
  getResponse(widgetId?: string): string;
  reset(widgetId?: string): void;
}

// Vendored Kubeez scroll-world engine (site/public/world-assets/v1/scrub-engine.js)
// — loaded as a classic, blocking script in world.html, so the global is defined
// before the deferred world.ts module calls it. Types cover the mount config used
// by src/world/world.ts (#160).
interface ScrollWorldCta {
  label: string;
  href: string;
}

interface ScrollWorldSection {
  id: string;
  label: string;
  still: string;
  stillAlt: string;
  clip: string;
  clipMobile: string;
  accent: string;
  linger?: number;
  eyebrow?: string;
  title?: string;
  body?: string;
  cta?: { primary?: ScrollWorldCta; secondary?: ScrollWorldCta };
}

interface ScrollWorldConfig {
  brand: { name: string; href: string };
  nav: boolean;
  cta: ScrollWorldCta;
  diveScroll: number;
  connScroll: number;
  sections: ScrollWorldSection[];
  connectors: string[];
  connectorsMobile: string[];
}

interface Window {
  hcaptcha?: HCaptcha;
  mountScrollWorld?(container: HTMLElement, config: ScrollWorldConfig): void;
}
