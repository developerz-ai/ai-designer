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

interface Window {
  hcaptcha?: HCaptcha;
}
