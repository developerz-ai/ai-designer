/// <reference types="vite/client" />

// Side-effect SCSS imports (import './styles/main.scss') need an ambient module
// declaration for tsc; vite/client covers most asset types but not bare .scss.
declare module '*.scss';
