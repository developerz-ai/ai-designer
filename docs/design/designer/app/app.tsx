'use client';

/**
 * Designer — Chrome MV3 side panel, complete UI specification.
 * Every state stacked vertically, each in a 360px frame with a caption.
 * No external imports beyond React. No component libraries. No icon packages.
 */

import { useState } from 'react';

/* ------------------------------------------------------------------ */
/* tokens + the only global CSS this file needs                        */
/* ------------------------------------------------------------------ */

const TOKENS = `
:root{
  /* Brand */
  --dz-accent:#f97316;
  --dz-accent-fg:#1a1205;

  /* Elevation */
  --dz-elev-base:#0f1115;
  --dz-elev-card:#171a21;
  --dz-elev-hover:#1f232c;
  --dz-elev-inset:#0b0d11;

  /* Foreground ramp */
  --dz-fg-strong:#edeff2;
  --dz-fg:#e6e8eb;
  --dz-fg-body:#c9cdd4;
  --dz-fg-muted:#8b909a;

  /* Borders */
  --dz-border-subtle:#232733;
  --dz-border-strong:#6b7285;

  /* Interaction washes */
  --dz-wash-hover:rgba(255,255,255,.06);
  --dz-wash-active:rgba(255,255,255,.10);
  --dz-scrim:rgba(0,0,0,.55);

  /* Status */
  --dz-status-connected:#22c55e;
  --dz-status-warning:#fbbf24;
  --dz-status-error:#ff6b6b;

  /* ---- ADDED TOKENS (all derived from the palette above) ---- */
  --dz-accent-fill:rgba(249,115,22,.10);   /* faint accent wash: reference rect fill, chip bg */
  --dz-accent-line:rgba(249,115,22,.45);   /* accent hairline: chip border, hover rect */
  --dz-warn-fill:rgba(251,191,36,.10);     /* fragile-selector rect fill */
  --dz-warn-line:rgba(251,191,36,.50);
  --dz-error-fill:rgba(255,107,107,.10);   /* error strips */
  --dz-ok-fill:rgba(34,197,94,.12);        /* readiness pill "Ready" bg */
  --dz-font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --dz-font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
}

.dz{font-family:var(--dz-font-sans);color:var(--dz-fg);-webkit-font-smoothing:antialiased}
.dz-mono{font-family:var(--dz-font-mono)}

/* Overlay scrollbars: thin, transparent track, thumb only on hover,
   gutter reserved so nothing reflows when the thumb appears. */
.dz-scroll{overflow-y:auto;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:transparent transparent}
.dz-scroll:hover{scrollbar-color:var(--dz-border-strong) transparent}
.dz-scroll::-webkit-scrollbar{width:8px;height:8px}
.dz-scroll::-webkit-scrollbar-track{background:transparent}
.dz-scroll::-webkit-scrollbar-thumb{background:transparent;border:2px solid transparent;background-clip:content-box;border-radius:9999px}
.dz-scroll:hover::-webkit-scrollbar-thumb{background:var(--dz-border-subtle);background-clip:content-box}
.dz-scroll:hover::-webkit-scrollbar-thumb:hover{background:var(--dz-border-strong);background-clip:content-box}
.dz-scroll-x{overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:transparent transparent}
.dz-scroll-x:hover{scrollbar-color:var(--dz-border-subtle) transparent}

/* Hit-area expansion: keeps a 28/32px control at a 44px pointer target. */
.dz-hit{position:relative}
.dz-hit::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:44px;min-height:44px;width:100%;height:100%}

/* One focus treatment, everywhere. */
.dz :focus-visible{outline:2px solid var(--dz-accent);outline-offset:2px;border-radius:6px}

/* Long selectors / URLs wrap instead of widening the 360px panel. */
.dz-wrap{overflow-wrap:anywhere;word-break:break-word}

.dz-prose p{margin:0 0 10px}
.dz-prose p:last-child{margin-bottom:0}
.dz-prose strong{color:var(--dz-fg-strong);font-weight:600}
.dz-prose h1{font-size:17px;line-height:1.25;font-weight:600;color:var(--dz-fg-strong);margin:14px 0 8px}
.dz-prose h2{font-size:15px;line-height:1.25;font-weight:600;color:var(--dz-fg-strong);margin:14px 0 6px}
.dz-prose h3{font-size:13px;line-height:1.25;font-weight:600;color:var(--dz-fg-strong);margin:12px 0 4px;letter-spacing:.02em}
.dz-prose ul,.dz-prose ol{margin:0 0 10px;padding-left:18px}
.dz-prose li{margin:0 0 4px}
.dz-prose ul li{list-style:disc}
.dz-prose ol li{list-style:decimal}
.dz-prose a{color:var(--dz-accent);text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
.dz-prose code{font-family:var(--dz-font-mono);font-size:12px;background:var(--dz-elev-inset);border:1px solid var(--dz-border-subtle);border-radius:4px;padding:1px 4px;overflow-wrap:anywhere}
.dz-prose blockquote{margin:0 0 10px;padding:2px 0 2px 10px;border-left:2px solid var(--dz-border-subtle);color:var(--dz-fg-muted)}

@keyframes dz-spin{to{transform:rotate(360deg)}}
@keyframes dz-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.dz-spin{animation:dz-spin 900ms linear infinite}
.dz-caret{display:inline-block;width:7px;height:15px;vertical-align:-2px;background:var(--dz-accent);animation:dz-pulse 1s ease-in-out infinite}
.dz-dot-1{animation:dz-pulse 1.2s ease-in-out infinite}
.dz-dot-2{animation:dz-pulse 1.2s ease-in-out .2s infinite}
.dz-dot-3{animation:dz-pulse 1.2s ease-in-out .4s infinite}
.dz-t{transition:background-color 120ms ease,color 120ms ease,border-color 120ms ease,opacity 120ms ease,transform 120ms ease}

@media (prefers-reduced-motion: reduce){
  .dz-spin,.dz-caret,.dz-dot-1,.dz-dot-2,.dz-dot-3{animation:none}
  .dz-t{transition:none}
}
`;

/* ------------------------------------------------------------------ */
/* icons — inline, 16px, currentColor                                  */
/* ------------------------------------------------------------------ */

type IP = { className?: string; size?: number };
const S = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
function Svg({ className, size = 16, children }: IP & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      {...S}
    >
      {children}
    </svg>
  );
}
const ICheck = (p: IP) => (
  <Svg {...p}>
    <path d="M3 8.5 6.2 11.6 13 4.6" />
  </Svg>
);
const IWarn = (p: IP) => (
  <Svg {...p}>
    <path d="M8 2.6 14.4 13.4H1.6L8 2.6Z" />
    <path d="M8 6.6v3.1M8 11.7h.01" />
  </Svg>
);
const IX = (p: IP) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
const IChevDown = (p: IP) => (
  <Svg {...p}>
    <path d="M4 6.5 8 10.5 12 6.5" />
  </Svg>
);
const IChevUp = (p: IP) => (
  <Svg {...p}>
    <path d="M4 9.5 8 5.5 12 9.5" />
  </Svg>
);
const IChevRight = (p: IP) => (
  <Svg {...p}>
    <path d="M6.5 4 10.5 8 6.5 12" />
  </Svg>
);
const IArrowUp = (p: IP) => (
  <Svg {...p}>
    <path d="M8 13V3.5M8 3.5 4.2 7.3M8 3.5l3.8 3.8" />
  </Svg>
);
const IArrowRight = (p: IP) => (
  <Svg {...p}>
    <path d="M3 8h9.5M12.5 8 8.9 4.4M12.5 8l-3.6 3.6" />
  </Svg>
);
const ISquare = (p: IP) => (
  <Svg {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);
const IPlay = (p: IP) => (
  <Svg {...p}>
    <path d="M5 3.6 12.4 8 5 12.4V3.6Z" fill="currentColor" stroke="none" />
  </Svg>
);
const ISpinner = (p: IP) => (
  <Svg {...p} className={`dz-spin ${p.className ?? ''}`}>
    <circle cx="8" cy="8" r="5.5" opacity=".25" />
    <path d="M13.5 8A5.5 5.5 0 0 0 8 2.5" />
  </Svg>
);
const ITarget = (p: IP) => (
  <Svg {...p}>
    <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
    <rect x="5" y="5" width="6" height="6" rx="1" />
  </Svg>
);
const IDiff = (p: IP) => (
  <Svg {...p}>
    <path d="M4 2.5v11M2 5h4M2.5 11.5h3" />
    <path d="M12 13.5v-11M10 11h4" />
  </Svg>
);
const IHistory = (p: IP) => (
  <Svg {...p}>
    <path d="M8 4.2V8l2.6 1.6" />
    <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8L2.4 6" />
    <path d="M2.2 2.8v3.3h3.3" />
  </Svg>
);
const IInfo = (p: IP) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.4v3.4M8 5.3h.01" />
  </Svg>
);
const IExternal = (p: IP) => (
  <Svg {...p}>
    <path d="M9 3h4v4M12.6 3.4 7.4 8.6" />
    <path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.6" />
  </Svg>
);
const ITrash = (p: IP) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" />
  </Svg>
);
const ISearch = (p: IP) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.3" />
    <path d="M10.2 10.2 14 14" />
  </Svg>
);
const IDownload = (p: IP) => (
  <Svg {...p}>
    <path d="M8 2.5v7.5M8 10 4.6 6.6M8 10l3.4-3.4M3 13h10" />
  </Svg>
);
const IShip = (p: IP) => (
  <Svg {...p}>
    <path d="M8 1.8c2 1.6 3 3.6 3 6l-3 6.4-3-6.4c0-2.4 1-4.4 3-6Z" />
    <circle cx="8" cy="6.6" r="1.4" />
  </Svg>
);
const ICopyDoc = (p: IP) => (
  <Svg {...p}>
    <rect x="5.5" y="2.5" width="8" height="9" rx="1.5" />
    <path d="M10.5 13.5H4a1.5 1.5 0 0 1-1.5-1.5V5" />
  </Svg>
);
const IBug = (p: IP) => (
  <Svg {...p}>
    <rect x="5" y="5.5" width="6" height="7.5" rx="3" />
    <path d="M5 8H2.5M11 8h2.5M5.4 11.4 3.4 12.6M10.6 11.4l2 1.2M6 5.2 5 3.4M10 5.2l1-1.8" />
  </Svg>
);
const ISliders = (p: IP) => (
  <Svg {...p}>
    <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    <circle cx="6" cy="4.5" r="1.4" fill="var(--dz-elev-card)" />
    <circle cx="10" cy="8" r="1.4" fill="var(--dz-elev-card)" />
    <circle cx="5" cy="11.5" r="1.4" fill="var(--dz-elev-card)" />
  </Svg>
);
const IPlug = (p: IP) => (
  <Svg {...p}>
    <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0V5.5ZM8 11.2v2.3" />
  </Svg>
);
const IAt = (p: IP) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.4" />
    <path d="M10.4 5.6v3.2a1.7 1.7 0 0 0 3.1.9A6 6 0 1 0 11 13.4" />
  </Svg>
);
const ILink = (p: IP) => (
  <Svg {...p}>
    <path d="M6.6 9.4 9.4 6.6" />
    <path d="M7.6 4.6 8.9 3.3a2.6 2.6 0 0 1 3.8 3.8l-1.3 1.3M8.4 11.4 7.1 12.7a2.6 2.6 0 0 1-3.8-3.8l1.3-1.3" />
  </Svg>
);

/* ------------------------------------------------------------------ */
/* frame primitives                                                    */
/* ------------------------------------------------------------------ */

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="h-[10px] w-[2px] shrink-0 bg-[var(--dz-accent)]" />
      <span className="text-[12px] leading-[1.4] font-medium text-[var(--dz-fg-muted)]">
        {children}
      </span>
    </div>
  );
}

function Frame({
  caption,
  children,
  width = 360,
  height,
}: {
  caption: string;
  children: React.ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <div className="dz">
      <Caption>{caption}</Caption>
      <div
        className="overflow-hidden rounded-[12px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-base)]"
        style={{ width, height }}
      >
        {children}
      </div>
    </div>
  );
}

function SectionHeading({ n, title, note }: { n: string; title: string; note?: string }) {
  return (
    <div className="dz col-span-full mt-8 mb-1 w-full border-t border-[var(--dz-border-subtle)] pt-6">
      <div className="flex items-baseline gap-3">
        <span className="dz-mono text-[12px] text-[var(--dz-accent)]">{n}</span>
        <h2 className="text-[17px] leading-[1.25] font-semibold text-[var(--dz-fg-strong)]">
          {title}
        </h2>
      </div>
      {note ? (
        <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-[var(--dz-fg-muted)]">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* shell: header, readiness pill, tab strip                            */
/* ------------------------------------------------------------------ */

type Ready = 'ready' | 'setup' | 'running';

function Logo() {
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-[var(--dz-accent)]"
      aria-hidden="true"
    >
      <span className="h-[6px] w-[6px] rounded-[1px] bg-[var(--dz-accent-fg)]" />
    </span>
  );
}

function ReadinessPill({
  state,
  open,
  onToggle,
}: {
  state: Ready;
  open?: boolean;
  onToggle?: () => void;
}) {
  const map = {
    ready: {
      label: 'Ready',
      color: 'var(--dz-status-connected)',
      bg: 'var(--dz-ok-fill)',
      Icon: ICheck,
    },
    setup: {
      label: 'Setup needed',
      color: 'var(--dz-status-warning)',
      bg: 'var(--dz-warn-fill)',
      Icon: IWarn,
    },
    running: {
      label: 'Running…',
      color: 'var(--dz-status-connected)',
      bg: 'var(--dz-ok-fill)',
      Icon: ICheck,
    },
  }[state];
  const Icon = map.Icon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!!open}
      aria-haspopup="dialog"
      className="dz-hit dz-t flex h-[28px] shrink-0 items-center gap-[6px] rounded-[9999px] border px-[8px] text-[12px] leading-[1.4] font-medium"
      style={{ background: map.bg, borderColor: map.color, color: map.color }}
    >
      <Icon size={13} />
      <span>{map.label}</span>
      <span className="text-[var(--dz-fg-muted)]">
        {open ? <IChevUp size={12} /> : <IChevDown size={12} />}
      </span>
    </button>
  );
}

type CheckRow = {
  label: string;
  status: 'ok' | 'warn' | 'err';
  detail?: string;
  fix?: string;
};

function ReadinessDropdown({ error }: { error?: string }) {
  const rows: CheckRow[] = [
    { label: 'AI provider', status: 'ok', detail: 'OpenRouter' },
    { label: 'Model', status: 'ok', detail: 'glm-4.6' },
    { label: 'API key', status: 'ok', detail: 'not required for local endpoint' },
    {
      label: 'Host permission',
      status: 'err',
      detail: 'nvidia.com is not in the allow list',
      fix: 'Fix',
    },
    {
      label: 'Page access',
      status: 'err',
      detail: 'Panel cannot read the current tab yet',
      fix: 'Grant',
    },
    { label: 'MCP backend', status: 'warn', detail: '2 of 3 connected' },
    { label: 'On-page overlay', status: 'ok', detail: 'Rectangles and step narration' },
  ];
  return (
    <div className="rounded-[12px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[6px] shadow-[0_12px_28px_rgba(0,0,0,.45)]">
      <p className="px-[8px] pt-[4px] pb-[6px] text-[11px] leading-[1.4] font-medium tracking-[.06em] text-[var(--dz-fg-muted)] uppercase">
        Readiness
      </p>
      <ul className="flex flex-col">
        {rows.slice(0, 6).map((r) => (
          <li key={r.label}>
            <div className="dz-t flex gap-[8px] rounded-[8px] px-[8px] py-[7px] hover:bg-[var(--dz-wash-hover)]">
              <span
                className="mt-[2px] shrink-0"
                style={{
                  color:
                    r.status === 'ok'
                      ? 'var(--dz-status-connected)'
                      : r.status === 'warn'
                        ? 'var(--dz-status-warning)'
                        : 'var(--dz-status-error)',
                }}
              >
                {r.status === 'ok' ? <ICheck size={14} /> : <IWarn size={14} />}
              </span>
              {/* detail stacks BELOW the label — never beside it */}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-[1.4] font-medium text-[var(--dz-fg)]">
                  {r.label}
                </span>
                {r.detail ? (
                  <span className="dz-wrap mt-[2px] block text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                    {r.detail}
                  </span>
                ) : null}
              </span>
              {r.fix ? (
                <button
                  type="button"
                  className="dz-hit dz-t -my-[2px] shrink-0 self-start rounded-[6px] px-[6px] py-[3px] text-[12px] leading-[1.4] font-medium text-[var(--dz-accent)] hover:bg-[var(--dz-wash-hover)]"
                >
                  {r.fix} {r.fix === 'Fix' ? '→' : ''}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {/* the 8th row is a toggle, not a check */}
      <div className="mt-[4px] border-t border-[var(--dz-border-subtle)] pt-[4px]">
        <button
          type="button"
          role="switch"
          aria-checked="true"
          className="dz-t flex w-full items-center gap-[8px] rounded-[8px] px-[8px] py-[8px] text-left hover:bg-[var(--dz-wash-hover)]"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] leading-[1.4] font-medium text-[var(--dz-fg)]">
              On-page overlay
            </span>
            <span className="mt-[2px] block text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
              Draw rectangles and narrate steps on the page
            </span>
          </span>
          <span className="dz-t flex h-[18px] w-[32px] shrink-0 items-center rounded-[9999px] bg-[var(--dz-accent)] px-[2px]">
            <span className="ml-auto h-[14px] w-[14px] rounded-[9999px] bg-[var(--dz-accent-fg)]" />
          </span>
        </button>
      </div>

      {error ? (
        <p
          className="dz-wrap mt-[4px] rounded-[8px] px-[8px] py-[6px] text-[12px] leading-[1.4]"
          style={{ background: 'var(--dz-error-fill)', color: 'var(--dz-status-error)' }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Header({
  state = 'ready',
  dropdown = false,
  running = false,
  disabled = false,
}: {
  state?: Ready;
  dropdown?: boolean;
  running?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(dropdown);
  return (
    <div className="relative">
      <div className="flex h-[40px] items-center gap-[8px] border-b border-[var(--dz-border-subtle)] px-[16px]">
        <Logo />
        <span className="mr-auto text-[13px] leading-[1.4] font-semibold text-[var(--dz-fg-strong)]">
          Designer
        </span>
        <ReadinessPill state={state} open={open} onToggle={() => setOpen((v) => !v)} />
        <button
          type="button"
          disabled={disabled}
          className="dz-hit dz-t flex h-[28px] shrink-0 items-center gap-[5px] rounded-[9999px] px-[10px] text-[12px] leading-[1.4] font-semibold disabled:opacity-40"
          style={
            running
              ? {
                  background: 'transparent',
                  color: 'var(--dz-fg)',
                  border: '1px solid var(--dz-border-strong)',
                }
              : { background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }
          }
        >
          {running ? <ISquare size={11} /> : <IPlay size={11} />}
          {running ? 'Stop' : 'Start'}
        </button>
      </div>
      {open ? (
        <div className="absolute top-[44px] right-[8px] left-[8px] z-20">
          <ReadinessDropdown
            error={state === 'setup' ? 'Last run failed: host permission was denied.' : undefined}
          />
        </div>
      ) : null}
    </div>
  );
}

/* Tab strip: text tabs flex, icon tabs are fixed 36px squares with aria-labels.
   A leading-icon variant would cost ~40px per text tab, which 360px cannot pay. */
type TabKey = 'chat' | 'diff' | 'mcp' | 'history' | 'settings';
function TabStrip({ active = 'chat' }: { active?: TabKey }) {
  const [cur, setCur] = useState<TabKey>(active);
  const base =
    'dz-hit dz-t relative flex h-[36px] items-center justify-center text-[12px] leading-[1.4] font-medium border-b-2';
  const on = { color: 'var(--dz-fg-strong)', borderColor: 'var(--dz-accent)' };
  const off = { color: 'var(--dz-fg-muted)', borderColor: 'transparent' };
  return (
    <div
      role="tablist"
      aria-label="Panel sections"
      className="flex items-stretch gap-[2px] border-b border-[var(--dz-border-subtle)] px-[10px]"
    >
      <button
        role="tab"
        aria-selected={cur === 'chat'}
        onClick={() => setCur('chat')}
        className={`${base} flex-1`}
        style={cur === 'chat' ? on : off}
      >
        Chat
      </button>
      <button
        role="tab"
        aria-selected={cur === 'diff'}
        onClick={() => setCur('diff')}
        aria-label="Changeset"
        title="Changeset"
        className={`${base} w-[36px] shrink-0`}
        style={cur === 'diff' ? on : off}
      >
        <IDiff />
        <span className="absolute top-[4px] right-[2px] flex h-[14px] min-w-[14px] items-center justify-center rounded-[9999px] bg-[var(--dz-accent)] px-[3px] text-[10px] leading-none font-semibold text-[var(--dz-accent-fg)]">
          6
        </span>
      </button>
      <button
        role="tab"
        aria-selected={cur === 'mcp'}
        onClick={() => setCur('mcp')}
        className={`${base} flex-1`}
        style={cur === 'mcp' ? on : off}
      >
        MCP
      </button>
      <button
        role="tab"
        aria-selected={cur === 'history'}
        onClick={() => setCur('history')}
        aria-label="History"
        title="History"
        className={`${base} w-[36px] shrink-0`}
        style={cur === 'history' ? on : off}
      >
        <IHistory />
      </button>
      <button
        role="tab"
        aria-selected={cur === 'settings'}
        onClick={() => setCur('settings')}
        className={`${base} flex-1`}
        style={cur === 'settings' ? on : off}
      >
        Settings
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* element references                                                  */
/* ------------------------------------------------------------------ */

type Ref = { i: number; name: string; sel: string; fragile?: boolean };

const REFS: Ref[] = [
  { i: 1, name: 'Hero heading', sel: 'section.hero > h1' },
  { i: 2, name: 'Nav', sel: 'header nav.primary' },
  { i: 3, name: 'Pricing card 2', sel: '.pricing .card:nth-of-type(2)', fragile: true },
  { i: 4, name: 'Footer CTA', sel: 'footer .cta a.button' },
  { i: 5, name: 'Testimonial 1', sel: '.t-grid > div:nth-child(1) > p' },
];

function RefChip({ r, expanded, onExpand }: { r: Ref; expanded?: boolean; onExpand?: () => void }) {
  return (
    <span className="inline-flex max-w-full flex-col">
      <span
        className="dz-t inline-flex h-[24px] max-w-full items-center gap-[5px] rounded-[9999px] border pr-[3px] pl-[6px]"
        style={{
          background: r.fragile ? 'var(--dz-warn-fill)' : 'var(--dz-accent-fill)',
          borderColor: r.fragile ? 'var(--dz-warn-line)' : 'var(--dz-accent-line)',
        }}
      >
        <span
          className="dz-mono text-[10px] leading-none font-semibold"
          style={{ color: r.fragile ? 'var(--dz-status-warning)' : 'var(--dz-accent)' }}
        >
          {r.i}
        </span>
        {r.fragile ? (
          <span style={{ color: 'var(--dz-status-warning)' }} title="Fragile selector">
            <IWarn size={11} />
          </span>
        ) : null}
        <button
          type="button"
          onClick={onExpand}
          title={r.sel}
          className="max-w-[136px] truncate text-[12px] leading-[1.4] font-medium text-[var(--dz-fg)]"
        >
          {r.name}
        </button>
        <button
          type="button"
          aria-label={`Remove ${r.name}`}
          className="dz-hit dz-t flex h-[18px] w-[18px] items-center justify-center rounded-[9999px] text-[var(--dz-fg-muted)] hover:bg-[var(--dz-wash-active)] hover:text-[var(--dz-fg)]"
        >
          <IX size={11} />
        </button>
      </span>
      {expanded ? (
        <span className="dz-mono dz-wrap mt-[4px] rounded-[6px] bg-[var(--dz-elev-inset)] px-[6px] py-[4px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
          {r.sel}
        </span>
      ) : null}
    </span>
  );
}

/* 1–3 refs render inline. 4+ collapse to "3 elements ⌄" which expands into a
   wrapping block ABOVE the composer (composer never leaves the floor). */
function RefRow({
  refs,
  picking,
  defaultOpen,
}: {
  refs: Ref[];
  picking?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [expanded, setExpanded] = useState<number | null>(null);

  if (picking) {
    return (
      <div className="flex items-center gap-[8px] px-[2px] pb-[8px]">
        <span
          className="dz-t inline-flex h-[24px] items-center gap-[6px] rounded-[9999px] border px-[8px] text-[12px] leading-[1.4] font-medium"
          style={{
            borderColor: 'var(--dz-accent)',
            background: 'var(--dz-accent-fill)',
            color: 'var(--dz-accent)',
          }}
        >
          <ITarget size={12} />
          Picking…
        </span>
        <span className="dz-wrap min-w-0 flex-1 text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
          Click an element on the page · Esc to cancel
        </span>
      </div>
    );
  }
  if (refs.length === 0) return null;

  if (refs.length <= 3) {
    return (
      <div className="flex flex-wrap items-start gap-[6px] px-[2px] pb-[8px]">
        {refs.map((r) => (
          <RefChip
            key={r.i}
            r={r}
            expanded={expanded === r.i}
            onExpand={() => setExpanded(expanded === r.i ? null : r.i)}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="px-[2px] pb-[8px]">
      {open ? (
        <div className="flex flex-wrap items-start gap-[6px]">
          {refs.map((r) => (
            <RefChip
              key={r.i}
              r={r}
              expanded={expanded === r.i}
              onExpand={() => setExpanded(expanded === r.i ? null : r.i)}
            />
          ))}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="dz-hit dz-t inline-flex h-[24px] items-center gap-[4px] rounded-[9999px] px-[8px] text-[12px] leading-[1.4] font-medium text-[var(--dz-fg-muted)] hover:bg-[var(--dz-wash-hover)] hover:text-[var(--dz-fg)]"
          >
            Collapse <IChevUp size={12} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-[6px]">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="dz-hit dz-t inline-flex h-[24px] items-center gap-[6px] rounded-[9999px] border pr-[6px] pl-[7px]"
            style={{ background: 'var(--dz-accent-fill)', borderColor: 'var(--dz-accent-line)' }}
          >
            <span className="flex items-center gap-[2px]">
              {refs.slice(0, 3).map((r) => (
                <span
                  key={r.i}
                  className="dz-mono flex h-[14px] w-[14px] items-center justify-center rounded-[4px] text-[10px] leading-none font-semibold"
                  style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
                >
                  {r.i}
                </span>
              ))}
            </span>
            <span className="text-[12px] leading-[1.4] font-medium text-[var(--dz-fg)]">
              {refs.length} elements
            </span>
            <IChevDown size={12} />
          </button>
          <button
            type="button"
            className="dz-hit dz-t rounded-[6px] px-[4px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)] hover:text-[var(--dz-fg)]"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* composer                                                            */
/* ------------------------------------------------------------------ */

function ModelMenu() {
  const models = [
    'glm-4.6',
    'anthropic/claude-sonnet-4.6',
    'openai/gpt-5.3-mini',
    'google/gemini-3.1-flash',
    'deepseek/deepseek-v3.4',
    'qwen/qwen3-max',
    'meta-llama/llama-4-scout',
  ];
  return (
    <div className="absolute bottom-[36px] left-0 z-30 w-[228px] rounded-[12px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[6px] shadow-[0_16px_32px_rgba(0,0,0,.5)]">
      <div className="mb-[6px] flex h-[28px] items-center gap-[6px] rounded-[8px] bg-[var(--dz-elev-inset)] px-[8px]">
        <span className="text-[var(--dz-fg-muted)]">
          <ISearch size={13} />
        </span>
        <input
          placeholder="Search 312 models…"
          className="min-w-0 flex-1 bg-transparent text-[12px] leading-[1.4] text-[var(--dz-fg)] outline-none placeholder:text-[var(--dz-fg-muted)]"
        />
      </div>
      {/* popover exception to the single-scroller contract */}
      <ul className="dz-scroll max-h-[168px]">
        {models.map((m, i) => (
          <li key={m}>
            <button
              type="button"
              className="dz-t flex w-full items-center gap-[6px] rounded-[8px] px-[8px] py-[6px] text-left hover:bg-[var(--dz-wash-hover)]"
            >
              <span
                className="shrink-0"
                style={{ color: i === 0 ? 'var(--dz-accent)' : 'transparent' }}
                aria-hidden="true"
              >
                <ICheck size={13} />
              </span>
              <span className="dz-mono dz-wrap min-w-0 flex-1 text-[12px] leading-[1.4] text-[var(--dz-fg-body)]">
                {m}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MentionMenu() {
  return (
    <div className="absolute bottom-[70px] left-[8px] z-30 w-[248px] rounded-[12px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[6px] shadow-[0_16px_32px_rgba(0,0,0,.5)]">
      <p className="px-[8px] pt-[2px] pb-[6px] text-[11px] leading-[1.4] tracking-[.06em] text-[var(--dz-fg-muted)] uppercase">
        Recent elements
      </p>
      <ul>
        {REFS.slice(0, 4).map((r, i) => (
          <li key={r.i}>
            <button
              type="button"
              className="dz-t flex w-full items-center gap-[8px] rounded-[8px] px-[8px] py-[6px] text-left"
              style={i === 0 ? { background: 'var(--dz-elev-hover)' } : undefined}
            >
              <span
                className="dz-mono flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] text-[10px] leading-none font-semibold"
                style={{ background: 'var(--dz-accent-fill)', color: 'var(--dz-accent)' }}
              >
                {r.i}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] leading-[1.4] font-medium text-[var(--dz-fg)]">
                  {r.name}
                </span>
                <span className="dz-mono block truncate text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                  {r.sel}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="border-t border-[var(--dz-border-subtle)] px-[8px] pt-[6px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
        ↑↓ to move · Enter to attach
      </p>
    </div>
  );
}

function Composer({
  refs = [],
  picking = false,
  streaming = false,
  value,
  tall = false,
  mention = false,
  modelOpen = false,
  refsOpen = false,
}: {
  refs?: Ref[];
  picking?: boolean;
  streaming?: boolean;
  value?: string;
  tall?: boolean;
  mention?: boolean;
  modelOpen?: boolean;
  refsOpen?: boolean;
}) {
  const [mOpen, setMOpen] = useState(modelOpen);
  return (
    <div className="relative border-t border-[var(--dz-border-subtle)] px-[16px] pt-[10px] pb-[10px]">
      {mention ? <MentionMenu /> : null}
      <RefRow refs={refs} picking={picking} defaultOpen={refsOpen} />

      {/* one shell owns the border + focus treatment */}
      <div
        className="dz-t rounded-[16px] border bg-[var(--dz-elev-card)]"
        style={{ borderColor: picking ? 'var(--dz-accent)' : 'var(--dz-border-subtle)' }}
      >
        <label className="sr-only" htmlFor="dz-input">
          Message
        </label>
        {/* grows 1 row → 6 rows (max-h 132px), then scrolls internally */}
        <div className={`dz-scroll px-[12px] pt-[10px] pb-[6px] ${tall ? 'max-h-[132px]' : ''}`}>
          {value ? (
            <p className="dz-wrap text-[14px] leading-[1.5] whitespace-pre-wrap text-[var(--dz-fg)]">
              {value}
              {mention ? <span className="text-[var(--dz-accent)]">@he</span> : null}
            </p>
          ) : (
            <p className="text-[14px] leading-[1.5] text-[var(--dz-fg-muted)]">
              Tell the agent what to change…
            </p>
          )}
        </div>

        <div className="relative flex items-center gap-[2px] px-[6px] pb-[6px]">
          {mOpen ? <ModelMenu /> : null}
          <button
            type="button"
            aria-pressed={picking}
            aria-label="Pick an element on the page"
            title="Pick an element on the page"
            className="dz-hit dz-t flex h-[28px] w-[28px] items-center justify-center rounded-[8px]"
            style={
              picking
                ? { background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }
                : { color: 'var(--dz-fg-muted)' }
            }
          >
            <ITarget />
          </button>
          <button
            type="button"
            aria-label="Mention an element"
            title="Mention an element"
            className="dz-hit dz-t flex h-[28px] w-[28px] items-center justify-center rounded-[8px] text-[var(--dz-fg-muted)] hover:bg-[var(--dz-wash-hover)] hover:text-[var(--dz-fg)]"
          >
            <IAt />
          </button>
          {/* quiet text trigger — no second border inside the shell */}
          <button
            type="button"
            onClick={() => setMOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={mOpen}
            className="dz-hit dz-t mr-auto flex h-[28px] max-w-[132px] items-center gap-[3px] rounded-[8px] px-[6px] text-[12px] leading-[1.4] text-[var(--dz-fg-muted)] hover:text-[var(--dz-fg)]"
          >
            <span className="dz-mono truncate">glm-4.6</span>
            <IChevDown size={12} />
          </button>
          <button
            type="button"
            aria-label={streaming ? 'Stop generating' : 'Send'}
            className="dz-hit dz-t flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[9999px]"
            style={
              streaming
                ? {
                    background: 'var(--dz-elev-hover)',
                    color: 'var(--dz-fg)',
                    border: '1px solid var(--dz-border-strong)',
                  }
                : { background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }
            }
          >
            {streaming ? <ISquare size={12} /> : <IArrowUp />}
          </button>
        </div>
      </div>
      <p className="mt-[6px] px-[2px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
        Enter to send, Shift+Enter for a new line
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* chat pieces                                                         */
/* ------------------------------------------------------------------ */

function Avatar({ size = 24 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[9999px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)]"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="h-[8px] w-[8px] rounded-[2px] bg-[var(--dz-accent)]" />
    </span>
  );
}

function SuggestionRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="dz-t flex w-full items-center gap-[10px] rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] px-[12px] py-[10px] text-left hover:bg-[var(--dz-elev-hover)]"
    >
      <span className="shrink-0 text-[var(--dz-fg-muted)]">{icon}</span>
      <span className="dz-wrap min-w-0 flex-1 text-[13px] leading-[1.4] text-[var(--dz-fg)]">
        {children}
      </span>
      <span className="shrink-0 text-[var(--dz-fg-muted)]">
        <IChevRight size={13} />
      </span>
    </button>
  );
}

function ChatEmpty() {
  return (
    <div className="px-[16px] pt-[16px] pb-[8px]">
      <Avatar />
      <h3 className="mt-[10px] text-[17px] leading-[1.25] font-semibold text-[var(--dz-fg-strong)]">
        Tell the agent what to build
      </h3>
      <p className="mt-[4px] flex items-center gap-[4px] text-[12px] leading-[1.4] text-[var(--dz-fg-muted)]">
        Automatic
        <span title="Mode is inferred from your message. There is nothing to pick.">
          <IInfo size={12} />
        </span>
      </p>
      <p className="mt-[10px] text-[13px] leading-[1.55] text-[var(--dz-fg-body)]">
        It edits this page live — pin an element with the picker for context, or start with one of
        these:
      </p>
      <div className="mt-[12px] flex flex-col gap-[6px]">
        <SuggestionRow icon={<ICopyDoc />}>{"Copy nvidia's hero"}</SuggestionRow>
        <SuggestionRow icon={<IBug />}>
          Why is this drop-shadow filter blurring the whole card?
        </SuggestionRow>
        <SuggestionRow icon={<IShip />}>Ship my changes as a pull request</SuggestionRow>
      </div>
    </div>
  );
}

function UserTurn({ text, refs }: { text: string; refs?: Ref[] }) {
  return (
    <div className="flex flex-col items-end gap-[6px] pl-[28px]">
      {refs?.length ? (
        <div className="flex flex-wrap justify-end gap-[4px]">
          {refs.map((r) => (
            <span
              key={r.i}
              className="inline-flex h-[20px] items-center gap-[4px] rounded-[9999px] border px-[6px] text-[11px] leading-none font-medium"
              style={{ background: 'var(--dz-accent-fill)', borderColor: 'var(--dz-accent-line)' }}
            >
              <span className="dz-mono font-semibold" style={{ color: 'var(--dz-accent)' }}>
                {r.i}
              </span>
              <span className="max-w-[104px] truncate text-[var(--dz-fg-body)]">{r.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      <p className="dz-wrap rounded-[12px] rounded-br-[4px] bg-[var(--dz-elev-card)] px-[10px] py-[7px] text-[13px] leading-[1.4] text-[var(--dz-fg)]">
        {text}
      </p>
    </div>
  );
}

function AssistantProse({ streaming }: { streaming?: boolean }) {
  return (
    <div className="dz-prose text-[15px] leading-[1.55] text-[var(--dz-fg-body)]">
      <p>
        I pulled the identity off the reference and applied it to <code>section.hero</code>. The
        heading now uses a <strong>tighter 1.05 leading</strong> and the eyebrow label picks up the
        accent.
      </p>
      <h3>What changed</h3>
      <ul>
        <li>
          Heading scale <code>3.25rem → 4rem</code> above 900px
        </li>
        <li>Eyebrow set to the extracted accent</li>
        <li>Gutter raised to 24px so the CTA stops colliding</li>
      </ul>
      <pre className="dz-scroll-x dz-mono my-[10px] rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-inset)] p-[10px] text-[12px] leading-[1.5] text-[var(--dz-fg-body)]">
        {`.hero__title{
  font-size:clamp(3.25rem,6vw,4rem);
  line-height:1.05;
  letter-spacing:-.02em;
}`}
      </pre>
      <blockquote>
        The pricing card still inherits the old shadow token — say the word and I&apos;ll unify it.
      </blockquote>
      <p>
        Reference:{' '}
        <a href="#">https://www.nvidia.com/en-us/design-system/foundations/typography/</a>
        {streaming ? <span className="dz-caret" /> : null}
      </p>
    </div>
  );
}

type Tool = {
  name: string;
  kind?: 'read' | 'act' | 'info';
  status: 'running' | 'done' | 'error';
  summary?: string;
  sel?: string;
};

function ToolChip({ t, open }: { t: Tool; open?: boolean }) {
  const [exp, setExp] = useState(!!open);
  const color =
    t.status === 'done'
      ? 'var(--dz-status-connected)'
      : t.status === 'error'
        ? 'var(--dz-status-error)'
        : 'var(--dz-fg-muted)';
  return (
    <li>
      <div className="rounded-[8px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)]">
        <button
          type="button"
          onClick={t.sel ? () => setExp((v) => !v) : undefined}
          aria-expanded={t.sel ? exp : undefined}
          className="dz-t flex w-full items-center gap-[6px] rounded-[8px] px-[8px] py-[6px] text-left hover:bg-[var(--dz-elev-hover)]"
        >
          <span className="shrink-0" style={{ color }}>
            {t.status === 'running' ? (
              <ISpinner size={13} />
            ) : t.status === 'done' ? (
              <ICheck size={13} />
            ) : (
              <IWarn size={13} />
            )}
          </span>
          <span className="dz-mono shrink-0 text-[12px] leading-[1.4] text-[var(--dz-fg)]">
            {t.name}
          </span>
          {t.kind ? (
            <span className="shrink-0 rounded-[4px] bg-[var(--dz-elev-inset)] px-[4px] py-[1px] text-[10px] leading-[1.4] text-[var(--dz-fg-muted)]">
              {t.kind}
            </span>
          ) : null}
          {t.summary ? (
            <span className="min-w-0 flex-1 truncate text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
              {t.summary}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {t.sel ? (
            <span className="shrink-0 text-[var(--dz-fg-muted)]">
              {exp ? <IChevUp size={12} /> : <IChevDown size={12} />}
            </span>
          ) : null}
        </button>
        {t.sel && exp ? (
          <p className="dz-mono dz-wrap mx-[8px] mb-[8px] rounded-[6px] bg-[var(--dz-elev-inset)] px-[6px] py-[5px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
            {t.sel}
          </p>
        ) : null}
      </div>
    </li>
  );
}

const RUN: Tool[] = [
  { name: 'extractIdentity', kind: 'info', status: 'done', summary: '→ 4 colors' },
  { name: 'screenshot', kind: 'read', status: 'done', summary: '→ 1440×900' },
  {
    name: 'inspectVisually',
    kind: 'read',
    status: 'done',
    summary: '→ hero, nav',
    sel: 'section.hero',
  },
  {
    name: 'mutateElement',
    kind: 'act',
    status: 'done',
    summary: 'font-size',
    sel: 'section.hero > h1',
  },
  {
    name: 'mutateElement',
    kind: 'act',
    status: 'done',
    summary: 'line-height',
    sel: 'section.hero > h1',
  },
  {
    name: 'mutateElement',
    kind: 'act',
    status: 'done',
    summary: 'color',
    sel: 'section.hero .eyebrow',
  },
  {
    name: 'mutateElement',
    kind: 'act',
    status: 'error',
    summary: 'selector missed',
    sel: '.pricing .card:nth-of-type(2)',
  },
  { name: 'inspectVisually', kind: 'read', status: 'done', summary: '→ recheck', sel: '.pricing' },
  { name: 'mutateElement', kind: 'act', status: 'done', summary: 'padding', sel: 'section.hero' },
  { name: 'extractIdentity', kind: 'info', status: 'done', summary: '→ 2 fonts' },
  { name: 'screenshot', kind: 'read', status: 'done', summary: '→ after' },
  {
    name: 'mutateElement',
    kind: 'act',
    status: 'running',
    summary: 'gap: 24px',
    sel: 'section.hero .row',
  },
];

/* 12 chips collapse behind a group header. Collapsed still shows the running
   chip and any error chip, so the interesting rows are never hidden. */
function ToolRun({ tools, defaultOpen = false }: { tools: Tool[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const running = tools.filter((t) => t.status === 'running');
  const errored = tools.filter((t) => t.status === 'error');
  const pinned = [...running, ...errored];
  return (
    <div className="mt-[10px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="dz-hit dz-t flex w-full items-center gap-[6px] rounded-[8px] px-[2px] py-[4px] text-left text-[12px] leading-[1.4] text-[var(--dz-fg-muted)] hover:text-[var(--dz-fg)]"
      >
        {running.length ? (
          <ISpinner size={13} />
        ) : errored.length ? (
          <span style={{ color: 'var(--dz-status-error)' }}>
            <IWarn size={13} />
          </span>
        ) : (
          <span style={{ color: 'var(--dz-status-connected)' }}>
            <ICheck size={13} />
          </span>
        )}
        <span className="font-medium">{tools.length} actions</span>
        {errored.length ? (
          <span style={{ color: 'var(--dz-status-error)' }}>· 1 failed</span>
        ) : null}
        <span className="ml-auto">{open ? <IChevUp size={12} /> : <IChevDown size={12} />}</span>
      </button>
      <ul className="mt-[6px] flex flex-col gap-[4px]">
        {(open ? tools : pinned).map((t, i) => (
          <ToolChip key={i} t={t} open={!open && t.status === 'error'} />
        ))}
      </ul>
    </div>
  );
}

function EditsSummary({ n = 4 }: { n?: number }) {
  return (
    <p className="mt-[10px] flex items-center gap-[6px] text-[12px] leading-[1.4] text-[var(--dz-fg-muted)]">
      <span style={{ color: 'var(--dz-status-connected)' }}>
        <ICheck size={13} />
      </span>
      {n} edits recorded
      <button type="button" className="dz-t ml-auto text-[var(--dz-accent)] hover:underline">
        Review →
      </button>
    </p>
  );
}

function TurnError({ msg }: { msg: string }) {
  return (
    <p
      className="dz-wrap mt-[10px] flex gap-[6px] rounded-[8px] px-[8px] py-[7px] text-[12px] leading-[1.4]"
      style={{ background: 'var(--dz-error-fill)', color: 'var(--dz-status-error)' }}
    >
      <span className="mt-[1px] shrink-0">
        <IWarn size={13} />
      </span>
      {msg}
    </p>
  );
}

function StreamingIndicator() {
  return (
    <p className="flex items-center gap-[6px] text-[12px] leading-[1.4] text-[var(--dz-fg-muted)]">
      <span className="flex gap-[3px]" aria-hidden="true">
        <span className="dz-dot-1 h-[4px] w-[4px] rounded-full bg-[var(--dz-accent)]" />
        <span className="dz-dot-2 h-[4px] w-[4px] rounded-full bg-[var(--dz-accent)]" />
        <span className="dz-dot-3 h-[4px] w-[4px] rounded-full bg-[var(--dz-accent)]" />
      </span>
      Editing the page…
      <span className="sr-only">The assistant is generating a response.</span>
    </p>
  );
}

function TaskTimeline() {
  const rows = [
    { title: 'Tighten hero typography', status: 'working', counter: '2 of 3', stage: 'run' },
    { title: 'Unify shadow token', status: 'pr_open', pr: true, stage: 'pr' },
    {
      title: 'Raise pricing gutter',
      status: 'error',
      err: 'Backend rejected the patch: file moved',
      stage: 'err',
    },
  ];
  return (
    <div className="mt-[12px] rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[4px]">
      <p className="px-[8px] pt-[6px] pb-[4px] text-[11px] leading-[1.4] tracking-[.06em] text-[var(--dz-fg-muted)] uppercase">
        Backend tasks
      </p>
      <ol className="flex flex-col">
        {rows.map((r) => (
          <li
            key={r.title}
            className="dz-t rounded-[8px] px-[8px] py-[7px] hover:bg-[var(--dz-elev-hover)]"
          >
            <div className="flex items-center gap-[6px]">
              <span
                className="shrink-0"
                style={{
                  color:
                    r.stage === 'err'
                      ? 'var(--dz-status-error)'
                      : r.stage === 'pr'
                        ? 'var(--dz-status-connected)'
                        : 'var(--dz-fg-muted)',
                }}
              >
                {r.stage === 'run' ? (
                  <ISpinner size={13} />
                ) : r.stage === 'pr' ? (
                  <ICheck size={13} />
                ) : (
                  <IWarn size={13} />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4] text-[var(--dz-fg)]">
                {r.title}
              </span>
              <span className="dz-mono shrink-0 text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                {r.status}
              </span>
            </div>
            <div className="mt-[3px] flex items-center gap-[8px] pl-[19px]">
              {r.counter ? (
                <span className="text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                  {r.counter}
                </span>
              ) : null}
              {r.pr ? (
                <a
                  href="#"
                  className="dz-t inline-flex items-center gap-[4px] text-[11px] leading-[1.4] font-medium text-[var(--dz-accent)] hover:underline"
                >
                  View PR <IExternal size={11} />
                </a>
              ) : null}
            </div>
            {r.err ? (
              <p
                className="dz-wrap mt-[4px] pl-[19px] text-[11px] leading-[1.4]"
                style={{ color: 'var(--dz-status-error)' }}
              >
                {r.err}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function UsageMeter() {
  return (
    <p className="px-[16px] pt-[8px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
      Usage · 7 steps · ~48.2k tokens
    </p>
  );
}

/* Ship bar: primary Ship flexes; the two secondary actions become icon-only
   36px ghosts with accessible names, so all three fit one 328px row. */
function ShipBar({
  shipping = false,
  fallback = false,
  mapForm = false,
  error = false,
  menu = false,
}: {
  shipping?: boolean;
  fallback?: boolean;
  mapForm?: boolean;
  error?: boolean;
  menu?: boolean;
}) {
  const [open, setOpen] = useState(menu);
  return (
    <div className="relative border-t border-[var(--dz-border-subtle)] px-[16px] py-[10px]">
      <div className="flex items-center gap-[6px]">
        <button
          type="button"
          disabled={shipping}
          className="dz-t flex h-[32px] flex-1 items-center justify-center gap-[6px] rounded-[9999px] text-[13px] leading-[1.4] font-semibold disabled:opacity-70"
          style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
        >
          {shipping ? <ISpinner size={13} /> : <IShip size={13} />}
          {shipping ? 'Shipping…' : 'Ship'}
        </button>
        <button
          type="button"
          aria-label="Download brief"
          title="Download brief"
          className="dz-hit dz-t flex h-[32px] w-[36px] shrink-0 items-center justify-center rounded-[9999px] border border-[var(--dz-border-strong)] text-[var(--dz-fg)] hover:bg-[var(--dz-wash-hover)]"
        >
          <IDownload size={14} />
        </button>
        <button
          type="button"
          aria-label="Send to a specific backend"
          title="Send to…"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((v) => !v)}
          className="dz-hit dz-t flex h-[32px] w-[36px] shrink-0 items-center justify-center gap-[1px] rounded-[9999px] border border-[var(--dz-border-strong)] text-[var(--dz-fg)] hover:bg-[var(--dz-wash-hover)]"
        >
          <IPlug size={13} />
          <IChevDown size={11} />
        </button>
      </div>

      {open ? (
        <div className="absolute right-[16px] bottom-[46px] z-30 w-[212px] rounded-[12px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[6px] shadow-[0_16px_32px_rgba(0,0,0,.5)]">
          <p className="px-[8px] pt-[2px] pb-[6px] text-[11px] leading-[1.4] tracking-[.06em] text-[var(--dz-fg-muted)] uppercase">
            Send to
          </p>
          {[
            { l: 'acme / website', s: 'connected' },
            { l: 'acme / marketing', s: 'connected' },
            { l: 'local sandbox', s: 'connecting' },
          ].map((b) => (
            <button
              key={b.l}
              type="button"
              className="dz-t flex w-full items-center gap-[8px] rounded-[8px] px-[8px] py-[6px] text-left hover:bg-[var(--dz-wash-hover)]"
            >
              <span
                className="h-[6px] w-[6px] shrink-0 rounded-full"
                style={{
                  background:
                    b.s === 'connected' ? 'var(--dz-status-connected)' : 'var(--dz-status-warning)',
                }}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] leading-[1.4] text-[var(--dz-fg)]">
                {b.l}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {fallback ? (
        <p className="dz-wrap mt-[8px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
          Shipped as a report instead:{' '}
          <span className="text-[var(--dz-fg-body)]">no backend mapped for nvidia.com</span>
        </p>
      ) : null}

      {mapForm ? (
        <div className="mt-[8px] rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[10px]">
          <p className="text-[12px] leading-[1.4] font-medium text-[var(--dz-fg-strong)]">
            Map this origin to a repo
          </p>
          <p className="dz-mono mt-[2px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
            nvidia.com
          </p>
          <div className="mt-[8px] flex flex-col gap-[6px]">
            <Field label="Repository" placeholder="acme/website" />
            <div className="flex gap-[6px]">
              <Field label="Backend" placeholder="optional" />
              <Field label="Branch" placeholder="main" />
            </div>
          </div>
          <button
            type="button"
            className="dz-t mt-[8px] flex h-[28px] w-full items-center justify-center rounded-[9999px] text-[12px] leading-[1.4] font-semibold"
            style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
          >
            Map and ship
          </button>
        </div>
      ) : null}

      {error ? (
        <p
          className="dz-wrap mt-[8px] flex gap-[6px] rounded-[8px] px-[8px] py-[6px] text-[11px] leading-[1.4]"
          style={{ background: 'var(--dz-error-fill)', color: 'var(--dz-status-error)' }}
        >
          <span className="mt-[1px] shrink-0">
            <IWarn size={12} />
          </span>
          Ship failed: backend returned 401. Re-authenticate the MCP server.
        </p>
      ) : null}
    </div>
  );
}

function ComposerFiveExpanded() {
  return <Composer refs={REFS} refsOpen />;
}

function Field({
  label,
  placeholder,
  value,
  type,
  mono,
}: {
  label: string;
  placeholder?: string;
  value?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-[4px]">
      <span className="text-[11px] leading-[1.4] font-medium text-[var(--dz-fg-muted)]">
        {label}
      </span>
      <span className="dz-t flex h-[32px] items-center rounded-[8px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-inset)] px-[8px]">
        <input
          type={type}
          defaultValue={value}
          placeholder={placeholder}
          className={`min-w-0 flex-1 bg-transparent text-[12px] leading-[1.4] text-[var(--dz-fg)] outline-none placeholder:text-[var(--dz-fg-muted)] ${mono ? 'dz-mono' : ''}`}
        />
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* page-level mocks                                                    */
/* ------------------------------------------------------------------ */

function RefRect({
  label,
  variant,
  style,
}: {
  label: string;
  variant: 'hover' | 'pinned' | 'fragile';
  style: React.CSSProperties;
}) {
  const cfg = {
    hover: {
      border: '1px dashed var(--dz-accent-line)',
      bg: 'transparent',
      badge: 'var(--dz-elev-card)',
      fg: 'var(--dz-fg)',
    },
    pinned: {
      border: '2px solid var(--dz-accent)',
      bg: 'var(--dz-accent-fill)',
      badge: 'var(--dz-accent)',
      fg: 'var(--dz-accent-fg)',
    },
    fragile: {
      border: '2px dashed var(--dz-status-warning)',
      bg: 'var(--dz-warn-fill)',
      badge: 'var(--dz-status-warning)',
      fg: '#221a05',
    },
  }[variant];
  return (
    <div
      className="absolute"
      style={{ ...style, border: cfg.border, background: cfg.bg, borderRadius: 4 }}
    >
      <span
        className="dz-mono absolute -top-[9px] left-[-1px] inline-flex items-center gap-[4px] rounded-[4px] px-[5px] py-[2px] text-[10px] leading-[1.4] font-semibold whitespace-nowrap"
        style={{
          background: cfg.badge,
          color: cfg.fg,
          border: variant === 'hover' ? '1px solid var(--dz-accent-line)' : 'none',
        }}
      >
        {variant === 'fragile' ? '⚠ ' : ''}
        {label}
      </span>
    </div>
  );
}

function FakePage({ children }: { children?: React.ReactNode }) {
  return (
    <div className="relative h-[420px] bg-[#f5f5f7] p-[16px] text-[#111]">
      <div className="flex items-center gap-[10px] border-b border-black/10 pb-[10px]">
        <div className="h-[16px] w-[70px] rounded bg-black/70" />
        <div className="ml-auto flex gap-[12px]">
          {['Products', 'Solutions', 'Pricing', 'Docs'].map((t) => (
            <div key={t} className="text-[11px] text-black/60">
              {t}
            </div>
          ))}
        </div>
      </div>
      <div className="pt-[26px]">
        <div className="text-[10px] font-semibold tracking-[.12em] text-black/40 uppercase">
          Platform
        </div>
        <div className="mt-[6px] h-[26px] w-[68%] rounded bg-black/80" />
        <div className="mt-[8px] h-[10px] w-[80%] rounded bg-black/20" />
        <div className="mt-[5px] h-[10px] w-[62%] rounded bg-black/20" />
        <div className="mt-[14px] h-[26px] w-[104px] rounded bg-black/80" />
      </div>
      <div className="mt-[28px] grid grid-cols-3 gap-[10px]">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-[8px] border border-black/10 bg-white p-[10px]">
            <div className="h-[8px] w-[46px] rounded bg-black/30" />
            <div className="mt-[8px] h-[16px] w-[34px] rounded bg-black/70" />
            <div className="mt-[8px] h-[7px] w-full rounded bg-black/12" />
            <div className="mt-[4px] h-[7px] w-[70%] rounded bg-black/12" />
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* surfaces 2–5                                                        */
/* ------------------------------------------------------------------ */

function DiffCard({
  kind,
  target,
  before,
  after,
}: {
  kind: string;
  target: string;
  before: string;
  after: string;
}) {
  return (
    <div className="rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[10px]">
      <div className="flex items-start gap-[6px]">
        <span className="dz-mono dz-wrap min-w-0 flex-1 text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
          {target}
        </span>
        <button
          type="button"
          aria-label="Remove this edit"
          className="dz-hit dz-t -mt-[2px] shrink-0 rounded-[6px] p-[2px] text-[var(--dz-fg-muted)] hover:text-[var(--dz-status-error)]"
        >
          <IX size={13} />
        </button>
      </div>
      <p className="mt-[4px] text-[12px] leading-[1.4] font-medium text-[var(--dz-fg-strong)]">
        {kind}
      </p>
      {/* before / after: two stacked rows in one inset well, gutter glyph carries
          the direction so long values wrap instead of fighting for width */}
      <div className="mt-[8px] overflow-hidden rounded-[8px] bg-[var(--dz-elev-inset)]">
        <div className="flex gap-[6px] px-[8px] py-[5px]">
          <span className="dz-mono w-[10px] shrink-0 text-[11px] leading-[1.5] text-[var(--dz-status-error)]">
            −
          </span>
          <span className="dz-mono dz-wrap min-w-0 flex-1 text-[11px] leading-[1.5] text-[var(--dz-fg-muted)] line-through decoration-[var(--dz-status-error)]/50">
            {before}
          </span>
        </div>
        <div className="flex gap-[6px] border-t border-[var(--dz-border-subtle)] px-[8px] py-[5px]">
          <span className="dz-mono w-[10px] shrink-0 text-[11px] leading-[1.5] text-[var(--dz-status-connected)]">
            +
          </span>
          <span className="dz-mono dz-wrap min-w-0 flex-1 text-[11px] leading-[1.5] text-[var(--dz-fg-body)]">
            {after}
          </span>
        </div>
      </div>
    </div>
  );
}

function GroupLabel({ children, n }: { children: React.ReactNode; n: number }) {
  return (
    <div className="mt-[14px] mb-[6px] flex items-center gap-[8px] first:mt-0">
      <span className="text-[11px] leading-[1.4] font-semibold tracking-[.06em] text-[var(--dz-fg-muted)] uppercase">
        {children}
      </span>
      <span className="dz-mono text-[11px] text-[var(--dz-fg-muted)]">{n}</span>
      <span className="h-px flex-1 bg-[var(--dz-border-subtle)]" />
    </div>
  );
}

function ClearSession() {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setArmed((v) => !v)}
      className="dz-hit dz-t ml-auto flex h-[28px] items-center gap-[5px] rounded-[9999px] border px-[10px] text-[12px] leading-[1.4] font-medium"
      style={
        armed
          ? {
              borderColor: 'var(--dz-status-error)',
              color: 'var(--dz-status-error)',
              background: 'var(--dz-error-fill)',
            }
          : { borderColor: 'var(--dz-border-strong)', color: 'var(--dz-fg-muted)' }
      }
    >
      {armed ? <IWarn size={12} /> : <ITrash size={12} />}
      {armed ? 'Tap again to clear' : 'Clear session'}
    </button>
  );
}

function Combobox({ mode }: { mode: 'closed' | 'open' | 'unknown' }) {
  const list = ['glm-4.6', 'glm-4.6-air', 'anthropic/claude-sonnet-4.6', 'google/gemini-3.1-flash'];
  return (
    <div className="relative">
      <span className="mb-[4px] block text-[11px] leading-[1.4] font-medium text-[var(--dz-fg-muted)]">
        Model
      </span>
      <div className="flex gap-[6px]">
        <div
          className="dz-t flex h-[32px] min-w-0 flex-1 items-center gap-[6px] rounded-[8px] border bg-[var(--dz-elev-inset)] px-[8px]"
          style={{
            borderColor: mode === 'closed' ? 'var(--dz-border-subtle)' : 'var(--dz-accent)',
          }}
        >
          <span className="dz-mono min-w-0 flex-1 truncate text-[12px] leading-[1.4] text-[var(--dz-fg)]">
            {mode === 'closed' ? 'glm-4.6' : mode === 'open' ? 'glm' : 'my-org/private-tune-2b'}
          </span>
          {mode === 'unknown' ? (
            <span
              className="shrink-0 rounded-[4px] px-[4px] py-[1px] text-[10px] leading-[1.4]"
              style={{ background: 'var(--dz-warn-fill)', color: 'var(--dz-status-warning)' }}
            >
              custom
            </span>
          ) : null}
          <IChevDown size={12} />
        </div>
        <button
          type="button"
          className="dz-hit dz-t h-[32px] shrink-0 rounded-[8px] border border-[var(--dz-border-strong)] px-[10px] text-[12px] leading-[1.4] font-medium text-[var(--dz-fg)] hover:bg-[var(--dz-wash-hover)]"
        >
          Refresh
        </button>
      </div>
      {mode === 'open' ? (
        <div className="absolute top-[62px] right-0 left-0 z-20 rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[4px] shadow-[0_16px_32px_rgba(0,0,0,.5)]">
          {list.slice(0, 2).map((m, i) => (
            <button
              key={m}
              type="button"
              className="dz-mono dz-t flex w-full items-center gap-[6px] rounded-[6px] px-[8px] py-[6px] text-left text-[12px] leading-[1.4] text-[var(--dz-fg-body)]"
              style={i === 0 ? { background: 'var(--dz-elev-hover)' } : undefined}
            >
              <span style={{ color: i === 0 ? 'var(--dz-accent)' : 'transparent' }}>
                <ICheck size={12} />
              </span>
              {m}
            </button>
          ))}
          <p className="px-[8px] py-[5px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
            2 of 312 match · press Enter to use what you typed
          </p>
        </div>
      ) : null}
      {mode === 'unknown' ? (
        <p className="mt-[4px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
          Not in the fetched list. It will be sent to the endpoint as typed.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const [mentionDemo, setMentionDemo] = useState(true);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TOKENS }} />
      <main className="dz min-h-screen bg-[var(--dz-elev-base)] px-[24px] py-[32px]">
        <header className="mb-[24px] max-w-[70ch]">
          <div className="flex items-center gap-[8px]">
            <Logo />
            <h1 className="text-[17px] leading-[1.25] font-semibold text-[var(--dz-fg-strong)]">
              Designer — side panel specification
            </h1>
          </div>
          <p className="mt-[8px] text-[13px] leading-[1.55] text-[var(--dz-fg-body)]">
            Every state at the real width: 360px, dark only, system font, inline SVG. Frames are
            captioned. Menus, expanders and toggles are live; everything else is static markup so
            the structure reads.
          </p>
        </header>

        <div className="flex flex-wrap items-start gap-[24px]">
          {/* ---------------- shell ---------------- */}
          <SectionHeading
            n="00"
            title="Shell"
            note="Header 40px, one hairline, then the tab strip. Nothing else is chrome."
          />

          <Frame caption="Header — Ready">
            <Header state="ready" />
            <div className="h-[56px]" />
          </Frame>

          <Frame caption="Header — Setup needed, Start disabled">
            <Header state="setup" disabled />
            <div className="h-[56px]" />
          </Frame>

          <Frame caption="Header — Running…, Stop">
            <Header state="running" running />
            <div className="h-[56px]" />
          </Frame>

          <Frame caption="Readiness dropdown — mixed pass/fail + overlay toggle">
            <Header state="setup" dropdown disabled />
            <div className="h-[400px]" />
          </Frame>

          <Frame caption="Tab strip — Chat active (icon tabs: Changeset, History)">
            <TabStrip active="chat" />
            <div className="h-[40px]" />
          </Frame>

          <Frame caption="Tab strip — Changeset active">
            <TabStrip active="diff" />
            <div className="h-[40px]" />
          </Frame>

          {/* ---------------- chat ---------------- */}
          <SectionHeading
            n="01"
            title="Chat"
            note="One scroll region: the thread. Header, tab strip, chips, ship bar and composer are fixed."
          />

          <Frame caption="Chat — pre-start, not configured" height={560}>
            <Header state="setup" disabled />
            <TabStrip />
            <div className="px-[16px] pt-[24px]">
              <Avatar />
              <h3 className="mt-[10px] text-[17px] leading-[1.25] font-semibold text-[var(--dz-fg-strong)]">
                Add a provider to begin
              </h3>
              <p className="mt-[6px] text-[13px] leading-[1.55] text-[var(--dz-fg-body)]">
                Designer needs an AI provider and a model before it can touch this page. Your key
                stays on this device.
              </p>
              <button
                type="button"
                className="dz-t mt-[14px] flex h-[32px] items-center gap-[6px] rounded-[9999px] px-[14px] text-[13px] leading-[1.4] font-semibold"
                style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
              >
                <ISliders size={13} />
                Open settings
              </button>
            </div>
          </Frame>

          <Frame caption="Chat — pre-start, configured" height={560}>
            <Header state="ready" />
            <TabStrip />
            <div className="px-[16px] pt-[24px]">
              <Avatar />
              <h3 className="mt-[10px] text-[17px] leading-[1.25] font-semibold text-[var(--dz-fg-strong)]">
                Ready on nvidia.com
              </h3>
              <p className="mt-[6px] text-[13px] leading-[1.55] text-[var(--dz-fg-body)]">
                Start a session and Designer will edit the page in the tab beside this panel. Every
                edit is recorded so you can ship it as code.
              </p>
              <button
                type="button"
                className="dz-t mt-[14px] flex h-[32px] items-center gap-[6px] rounded-[9999px] px-[14px] text-[13px] leading-[1.4] font-semibold"
                style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
              >
                <IPlay size={12} />
                Start
              </button>
            </div>
          </Frame>

          <Frame caption="Chat — empty state (Leo intro rhythm)" height={620}>
            <Header state="running" running />
            <TabStrip />
            <div className="dz-scroll h-[416px]">
              <ChatEmpty />
            </div>
            <Composer />
          </Frame>

          <Frame caption="Chat — one turn, 12 tool calls collapsed" height={590}>
            <Header state="running" running />
            <TabStrip />
            <div className="dz-scroll h-[286px] px-[16px] py-[14px]">
              <div className="flex flex-col gap-[16px]">
                <UserTurn
                  text="Copy nvidia's hero typography onto these two."
                  refs={[REFS[0], REFS[1]]}
                />
                <div>
                  <div className="dz-prose text-[15px] leading-[1.55] text-[var(--dz-fg-body)]">
                    <p>
                      I pulled the identity off the reference and applied it to{' '}
                      <code>section.hero</code>. The heading now uses a{' '}
                      <strong>tighter 1.05 leading</strong> and the eyebrow label picks up the
                      accent.
                    </p>
                  </div>
                  <ToolRun tools={RUN} />
                  <EditsSummary n={4} />
                </div>
              </div>
            </div>
            <UsageMeter />
            <ShipBar />
            <Composer refs={[REFS[0], REFS[1]]} />
          </Frame>

          <Frame caption="Chat — 12 tool calls expanded (no nested scroller)" height={800}>
            <Header state="running" running />
            <TabStrip />
            <div className="dz-scroll h-[636px] px-[16px] py-[14px]">
              <ToolRun tools={RUN} defaultOpen />
              <EditsSummary n={4} />
            </div>
            <Composer />
          </Frame>

          <Frame caption="Chat — streaming, Stop in the send slot" height={620}>
            <Header state="running" running />
            <TabStrip />
            <div className="dz-scroll h-[456px] px-[16px] py-[14px]">
              <div className="flex flex-col gap-[16px]">
                <UserTurn text="Make the eyebrow label pick up the accent." />
                <div>
                  <StreamingIndicator />
                  <div className="mt-[8px]">
                    <AssistantProse streaming />
                  </div>
                  <ToolRun tools={RUN.slice(9)} />
                </div>
              </div>
            </div>
            <Composer streaming />
          </Frame>

          <Frame caption="Chat — turn error">
            <div className="px-[16px] py-[14px]">
              <UserTurn text="Swap the pricing cards to a 2-up grid." />
              <div className="mt-[16px]">
                <div className="dz-prose text-[15px] leading-[1.55] text-[var(--dz-fg-body)]">
                  <p>
                    I found <code>.pricing</code> but the third card is rendered by a framework
                    template, so I stopped before guessing.
                  </p>
                </div>
                <ToolRun tools={[RUN[6]]} />
                <TurnError msg="mutateElement failed: selector .pricing .card:nth-of-type(2) no longer resolves. The page re-rendered — re-pin the element and try again." />
              </div>
            </div>
          </Frame>

          <Frame caption="Chat — task timeline after Ship (working + pr_open + error)">
            <div className="px-[16px] py-[14px]">
              <div className="dz-prose text-[15px] leading-[1.55] text-[var(--dz-fg-body)]">
                <p>
                  Handed <strong>4 edits</strong> to <code>acme/website</code>. I&apos;ll keep this
                  list live.
                </p>
              </div>
              <TaskTimeline />
            </div>
          </Frame>

          <Frame caption="Ship bar — shipping + fallback hint">
            <ShipBar shipping fallback />
          </Frame>

          <Frame caption="Ship bar — Send to… menu open" height={172}>
            <div className="h-[110px]" />
            <ShipBar menu />
          </Frame>

          <Frame caption="Ship bar — origin → repo mini-form + error">
            <ShipBar mapForm error />
          </Frame>

          {/* ---------------- element references ---------------- */}
          <SectionHeading
            n="02"
            title="Element references"
            note="Cursor-style attachments: human names first, raw selector one disclosure away, index shared with the on-page rectangle."
          />

          <Frame caption="Composer — empty, no references">
            <Composer />
          </Frame>

          <Frame caption="Composer — picking… (user is hovering the page)">
            <Composer picking />
          </Frame>

          <Frame caption="Composer — one reference">
            <Composer refs={[REFS[0]]} />
          </Frame>

          <Frame caption="Composer — three references, one fragile, one expanded">
            <Composer refs={[REFS[0], REFS[1], REFS[2]]} />
          </Frame>

          <Frame caption="Composer — five references, collapsed to a stack chip">
            <Composer refs={REFS} />
          </Frame>

          <Frame caption="Composer — five references, expanded (wraps upward)">
            <ComposerFiveExpanded />
          </Frame>

          <Frame caption="Composer — @ mention menu, long input near the cap" height={330}>
            <div className="h-[36px]" />
            <Composer
              mention={mentionDemo}
              value={
                'Match the eyebrow, heading and CTA spacing to the reference, then check the mobile breakpoint at 390px for '
              }
              tall
            />
            <div className="px-[16px] pb-[10px]">
              <button
                type="button"
                onClick={() => setMentionDemo((v) => !v)}
                className="dz-t text-[11px] text-[var(--dz-fg-muted)] underline"
              >
                toggle mention menu
              </button>
            </div>
          </Frame>

          <Frame
            caption="Composer — model quick-switch menu (searchable, popover exception)"
            height={330}
          >
            <div className="h-[240px]" />
            <Composer modelOpen />
          </Frame>

          {/* ---------------- page mocks ---------------- */}
          <SectionHeading
            n="03"
            title="On the page"
            note="Rendered on the web page, not in the panel. Hover is a hairline dash, pinned is a solid 2px accent with a fill, fragile is amber dashed."
          />

          <Frame caption="Page — hover vs pinned vs fragile reference rectangles" width={720}>
            <FakePage>
              <RefRect
                label="[1] <section.hero > h1>"
                variant="pinned"
                style={{ left: 16, top: 118, width: 464, height: 34 }}
              />
              <RefRect
                label="<nav.primary>"
                variant="hover"
                style={{ left: 300, top: 16, width: 404, height: 26 }}
              />
              <RefRect
                label="[3] <.card:nth-of-type(2)> fragile path"
                variant="fragile"
                style={{ left: 248, top: 268, width: 216, height: 84 }}
              />
            </FakePage>
          </Frame>

          <Frame caption="Page — agent overlay narrating the current step" width={720}>
            <FakePage>
              <RefRect
                label="[1] <section.hero > h1>"
                variant="pinned"
                style={{ left: 16, top: 118, width: 464, height: 34 }}
              />
              <div className="absolute right-[16px] bottom-[16px] left-[16px]">
                <div className="dz flex items-center gap-[10px] rounded-[12px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] px-[12px] py-[10px] shadow-[0_18px_36px_rgba(0,0,0,.45)]">
                  <ISpinner size={16} className="text-[var(--dz-accent)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-[1.4] font-medium text-[var(--dz-fg-strong)]">
                      Step 5 of 9 · applying line-height
                    </span>
                    <span className="dz-mono dz-wrap mt-[2px] block text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                      section.hero &gt; h1
                    </span>
                  </span>
                  <span className="dz-mono shrink-0 rounded-[4px] bg-[var(--dz-elev-inset)] px-[5px] py-[2px] text-[10px] text-[var(--dz-fg-muted)]">
                    4 edits
                  </span>
                  <button
                    type="button"
                    className="dz-hit dz-t flex h-[28px] shrink-0 items-center gap-[5px] rounded-[9999px] border border-[var(--dz-border-strong)] px-[9px] text-[12px] font-medium text-[var(--dz-fg)]"
                  >
                    <ISquare size={10} />
                    Stop
                  </button>
                </div>
              </div>
            </FakePage>
          </Frame>

          {/* ---------------- changeset ---------------- */}
          <SectionHeading
            n="04"
            title="Changeset"
            note="One card per recorded edit, grouped by kind. Mutating controls freeze while a turn streams."
          />

          <Frame caption="Changeset — empty" height={340}>
            <Header state="ready" />
            <TabStrip active="diff" />
            <div className="px-[16px] pt-[40px] text-center">
              <p className="text-[13px] leading-[1.4] font-medium text-[var(--dz-fg)]">
                No edits recorded yet
              </p>
              <p className="mx-auto mt-[6px] max-w-[30ch] text-[12px] leading-[1.55] text-[var(--dz-fg-muted)]">
                Ask the agent to change something and it will show up here, ready to ship.
              </p>
            </div>
          </Frame>

          <Frame
            caption="Changeset — 6 edits across 3 kinds (streaming: controls disabled)"
            height={700}
          >
            <Header state="running" running />
            <TabStrip active="diff" />
            <div className="flex items-center gap-[6px] border-b border-[var(--dz-border-subtle)] px-[16px] py-[8px]">
              {['Undo', 'Redo'].map((l) => (
                <button
                  key={l}
                  type="button"
                  disabled
                  className="dz-hit dz-t flex h-[28px] items-center rounded-[9999px] border border-[var(--dz-border-strong)] px-[10px] text-[12px] leading-[1.4] font-medium text-[var(--dz-fg)] disabled:opacity-40"
                >
                  {l}
                </button>
              ))}
              <ClearSession />
            </div>
            <div className="dz-scroll h-[540px] px-[16px] py-[12px]">
              <GroupLabel n={3}>Classes</GroupLabel>
              <div className="flex flex-col gap-[6px]">
                <DiffCard
                  kind="font-size"
                  target="section.hero > h1"
                  before="3.25rem"
                  after="clamp(3.25rem, 6vw, 4rem)"
                />
                <DiffCard
                  kind="line-height"
                  target="section.hero > h1"
                  before="1.32"
                  after="1.05"
                />
                <DiffCard
                  kind="color"
                  target="section.hero .eyebrow"
                  before="rgb(107 114 133)"
                  after="var(--brand-accent)"
                />
              </div>
              <GroupLabel n={2}>Text</GroupLabel>
              <div className="flex flex-col gap-[6px]">
                <DiffCard
                  kind="textContent"
                  target="section.hero > h1"
                  before="Accelerate everything"
                  after="Build what's next, faster"
                />
                <DiffCard
                  kind="textContent"
                  target="footer .cta a.button"
                  before="Learn more"
                  after="Start free"
                />
              </div>
              <GroupLabel n={1}>Breakpoint</GroupLabel>
              <div className="flex flex-col gap-[6px]">
                <DiffCard
                  kind="@media (min-width: 900px)"
                  target=".pricing"
                  before="grid-template-columns: repeat(3, 1fr)"
                  after="grid-template-columns: repeat(2, minmax(0, 1fr))"
                />
              </div>
            </div>
          </Frame>

          {/* ---------------- mcp ---------------- */}
          <SectionHeading
            n="05"
            title="MCP backends"
            note="Server cards, add form, presets, auth modal, origin → repo mapping."
          />

          <Frame caption="MCP — servers, presets, add form, origin map" height={900}>
            <Header state="ready" />
            <TabStrip active="mcp" />
            <div className="dz-scroll h-[820px] px-[16px] py-[12px]">
              <GroupLabel n={3}>Servers</GroupLabel>
              <div className="flex flex-col gap-[6px]">
                {[
                  { l: 'acme / website', u: 'https://mcp.acme.dev/website', s: 'connected' },
                  { l: 'local sandbox', u: 'http://127.0.0.1:8787/mcp', s: 'connecting' },
                  { l: 'acme / marketing', u: 'https://mcp.acme.dev/marketing', s: 'error' },
                ].map((s) => (
                  <div
                    key={s.l}
                    className="rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[10px]"
                  >
                    <div className="flex items-center gap-[6px]">
                      <span
                        className="h-[7px] w-[7px] shrink-0 rounded-full"
                        style={{
                          background:
                            s.s === 'connected'
                              ? 'var(--dz-status-connected)'
                              : s.s === 'connecting'
                                ? 'var(--dz-status-warning)'
                                : s.s === 'error'
                                  ? 'var(--dz-status-error)'
                                  : 'var(--dz-fg-muted)',
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4] font-medium text-[var(--dz-fg-strong)]">
                        {s.l}
                      </span>
                      <span className="dz-mono shrink-0 text-[11px] text-[var(--dz-fg-muted)]">
                        {s.s}
                      </span>
                    </div>
                    <p className="dz-mono dz-wrap mt-[4px] text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                      {s.u}
                    </p>
                    <div className="mt-[8px] flex gap-[6px]">
                      <button
                        type="button"
                        className="dz-hit dz-t h-[28px] rounded-[9999px] border border-[var(--dz-border-strong)] px-[10px] text-[12px] font-medium text-[var(--dz-fg)] hover:bg-[var(--dz-wash-hover)]"
                      >
                        {s.s === 'connected' ? 'Disconnect' : 'Connect'}
                      </button>
                      <button
                        type="button"
                        className="dz-hit dz-t h-[28px] rounded-[9999px] px-[8px] text-[12px] text-[var(--dz-fg-muted)] hover:bg-[var(--dz-wash-hover)] hover:text-[var(--dz-fg)]"
                      >
                        Auth
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${s.l}`}
                        className="dz-hit dz-t ml-auto flex h-[28px] w-[28px] items-center justify-center rounded-[9999px] text-[var(--dz-fg-muted)] hover:text-[var(--dz-status-error)]"
                      >
                        <ITrash size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <GroupLabel n={3}>Quick add</GroupLabel>
              <div className="flex flex-wrap gap-[6px]">
                {['GitHub agent', 'Local bridge', 'Vercel'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="dz-hit dz-t h-[28px] rounded-[9999px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] px-[10px] text-[12px] font-medium text-[var(--dz-fg-body)] hover:bg-[var(--dz-elev-hover)]"
                  >
                    + {p}
                  </button>
                ))}
              </div>

              <GroupLabel n={2}>Add server</GroupLabel>
              <div className="flex flex-col gap-[6px] rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[10px]">
                <Field label="Label" placeholder="acme / docs" />
                <Field label="URL" placeholder="https://mcp.example.dev/docs" mono />
                <button
                  type="button"
                  className="dz-t mt-[2px] flex h-[28px] items-center justify-center rounded-[9999px] text-[12px] font-semibold"
                  style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
                >
                  Add server
                </button>
              </div>

              <GroupLabel n={2}>Origin → repo</GroupLabel>
              <div className="flex flex-col gap-[4px]">
                {[
                  ['example.com', 'acme/website'],
                  ['docs.example.com', 'acme/docs'],
                ].map(([o, r]) => (
                  <div
                    key={o}
                    className="flex items-center gap-[6px] rounded-[8px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] px-[10px] py-[7px]"
                  >
                    <span className="dz-mono min-w-0 flex-1 truncate text-[11px] text-[var(--dz-fg-body)]">
                      {o}
                    </span>
                    <span className="shrink-0 text-[var(--dz-fg-muted)]">
                      <IArrowRight size={13} />
                    </span>
                    <span className="dz-mono min-w-0 flex-1 truncate text-right text-[11px] text-[var(--dz-fg-body)]">
                      {r}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove mapping for ${o}`}
                      className="dz-hit dz-t shrink-0 text-[var(--dz-fg-muted)] hover:text-[var(--dz-status-error)]"
                    >
                      <IX size={13} />
                    </button>
                  </div>
                ))}
                <div className="mt-[2px] flex flex-col gap-[6px] rounded-[10px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[10px]">
                  <Field label="Repository" placeholder="acme/website" mono />
                  <div className="flex gap-[6px]">
                    <Field label="Backend" placeholder="optional" />
                    <Field label="Branch" placeholder="main" />
                  </div>
                  <button
                    type="button"
                    className="dz-t flex h-[28px] items-center justify-center rounded-[9999px] border border-[var(--dz-border-strong)] text-[12px] font-medium text-[var(--dz-fg)]"
                  >
                    Save mapping
                  </button>
                </div>
              </div>
            </div>
          </Frame>

          <Frame caption="MCP — auth dialog over a scrim" height={560}>
            <div className="relative h-full">
              <Header state="ready" />
              <TabStrip active="mcp" />
              <div className="absolute inset-0" style={{ background: 'var(--dz-scrim)' }} />
              <div className="absolute inset-x-[16px] top-[64px]">
                <div
                  role="dialog"
                  aria-label="Authenticate server"
                  className="rounded-[16px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[14px] shadow-[0_24px_48px_rgba(0,0,0,.6)]"
                >
                  <div className="flex items-start gap-[8px]">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] leading-[1.25] font-semibold text-[var(--dz-fg-strong)]">
                        Authenticate
                      </span>
                      <span className="dz-mono dz-wrap mt-[2px] block text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                        https://mcp.acme.dev/marketing
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label="Close"
                      className="dz-hit dz-t -mt-[2px] shrink-0 rounded-[6px] p-[2px] text-[var(--dz-fg-muted)] hover:text-[var(--dz-fg)]"
                    >
                      <IX />
                    </button>
                  </div>

                  <div className="mt-[12px] flex flex-col gap-[6px]">
                    <p className="text-[11px] leading-[1.4] font-semibold tracking-[.06em] text-[var(--dz-fg-muted)] uppercase">
                      API key
                    </p>
                    <Field label="Key" placeholder="Paste your key" type="password" />
                  </div>

                  <div className="my-[12px] flex items-center gap-[8px]">
                    <span className="h-px flex-1 bg-[var(--dz-border-subtle)]" />
                    <span className="text-[11px] text-[var(--dz-fg-muted)]">or</span>
                    <span className="h-px flex-1 bg-[var(--dz-border-subtle)]" />
                  </div>

                  <div className="flex flex-col gap-[6px]">
                    <p className="text-[11px] leading-[1.4] font-semibold tracking-[.06em] text-[var(--dz-fg-muted)] uppercase">
                      OAuth
                    </p>
                    <Field label="Authorization endpoint" placeholder="https://…/authorize" mono />
                    <Field label="Token endpoint" placeholder="https://…/token" mono />
                    <Field label="Client ID" placeholder="designer-panel" mono />
                    <Field label="Scope (optional)" placeholder="mcp:tools" mono />
                  </div>

                  <div className="mt-[14px] flex gap-[6px]">
                    <button
                      type="button"
                      className="dz-t flex h-[32px] flex-1 items-center justify-center rounded-[9999px] text-[13px] font-semibold"
                      style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
                    >
                      Connect
                    </button>
                    <button
                      type="button"
                      className="dz-t h-[32px] rounded-[9999px] px-[14px] text-[13px] font-medium text-[var(--dz-fg-muted)] hover:text-[var(--dz-fg)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Frame>

          {/* ---------------- history ---------------- */}
          <SectionHeading
            n="06"
            title="History"
            note="Ten sessions, ring buffer. A row opens a read-only replay."
          />

          <Frame caption="History — list" height={520}>
            <Header state="ready" />
            <TabStrip active="history" />
            <div className="dz-scroll h-[440px] py-[6px]">
              {[
                ['nvidia.com', 'GeForce RTX — Official Site', '2h ago', 12],
                ['stripe.com', 'Payments infrastructure', 'Yesterday', 4],
                ['acme.dev', 'Acme · Docs — Getting started', '3d ago', 21],
                ['linear.app', 'Linear — Plan and build', '1w ago', 2],
              ].map(([origin, title, when, n]) => (
                <div
                  key={origin as string}
                  className="dz-t flex items-center gap-[10px] px-[16px] py-[9px] hover:bg-[var(--dz-wash-hover)]"
                >
                  <span
                    className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] bg-[var(--dz-elev-hover)] text-[9px] font-semibold text-[var(--dz-fg-muted)]"
                    aria-hidden="true"
                  >
                    {(origin as string)[0].toUpperCase()}
                  </span>
                  <button type="button" className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[13px] leading-[1.4] font-medium text-[var(--dz-fg)]">
                      {title}
                    </span>
                    <span className="mt-[2px] block truncate text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                      {origin} · {when}
                    </span>
                  </button>
                  <span className="dz-mono shrink-0 rounded-[4px] bg-[var(--dz-elev-inset)] px-[5px] py-[2px] text-[10px] text-[var(--dz-fg-muted)]">
                    {n} edits
                  </span>
                  <button
                    type="button"
                    aria-label={`Delete session for ${origin}`}
                    className="dz-hit dz-t shrink-0 text-[var(--dz-fg-muted)] hover:text-[var(--dz-status-error)]"
                  >
                    <ITrash size={13} />
                  </button>
                </div>
              ))}
            </div>
          </Frame>

          <Frame caption="History — read-only replay (no composer)" height={520}>
            <div className="flex h-[40px] items-center gap-[8px] border-b border-[var(--dz-border-subtle)] px-[10px]">
              <button
                type="button"
                aria-label="Back to history"
                className="dz-hit dz-t flex h-[28px] w-[28px] items-center justify-center rounded-[8px] text-[var(--dz-fg-muted)] hover:bg-[var(--dz-wash-hover)] hover:text-[var(--dz-fg)]"
              >
                <span className="rotate-180">
                  <IChevRight />
                </span>
              </button>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-[1.4] font-semibold text-[var(--dz-fg-strong)]">
                  GeForce RTX — Official Site
                </span>
                <span className="block truncate text-[11px] leading-[1.4] text-[var(--dz-fg-muted)]">
                  nvidia.com · 2h ago · 12 edits
                </span>
              </span>
              <span className="shrink-0 rounded-[9999px] border border-[var(--dz-border-subtle)] px-[8px] py-[3px] text-[11px] text-[var(--dz-fg-muted)]">
                Read-only
              </span>
            </div>
            <div className="dz-scroll h-[478px] px-[16px] py-[14px]">
              <div className="flex flex-col gap-[16px]">
                <UserTurn text="Copy nvidia's hero typography." refs={[REFS[0]]} />
                <div>
                  <AssistantProse />
                  <ToolRun tools={RUN.slice(0, 4)} />
                  <EditsSummary n={12} />
                </div>
              </div>
            </div>
          </Frame>

          {/* ---------------- settings ---------------- */}
          <SectionHeading
            n="07"
            title="Settings"
            note="Provider, a free-text searchable model combobox, save states, About."
          />

          <Frame caption="Settings — combobox closed, key saved" height={620}>
            <Header state="ready" />
            <TabStrip active="settings" />
            <div className="dz-scroll h-[540px] px-[16px] py-[12px]">
              <GroupLabel n={3}>Provider</GroupLabel>
              <div className="flex flex-col gap-[10px]">
                <label className="flex flex-col gap-[4px]">
                  <span className="text-[11px] leading-[1.4] font-medium text-[var(--dz-fg-muted)]">
                    Preset
                  </span>
                  <span className="dz-t flex h-[32px] items-center rounded-[8px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-inset)] px-[8px]">
                    <span className="flex-1 text-[12px] text-[var(--dz-fg)]">OpenRouter</span>
                    <IChevDown size={12} />
                  </span>
                </label>
                <Field label="API key" placeholder="•••• saved" type="password" />
                <Combobox mode="closed" />
                <div className="flex items-center gap-[8px]">
                  <button
                    type="button"
                    className="dz-t flex h-[32px] items-center gap-[6px] rounded-[9999px] px-[14px] text-[13px] font-semibold"
                    style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
                  >
                    Save
                  </button>
                  <span className="flex items-center gap-[5px] text-[12px] text-[var(--dz-status-connected)]">
                    <ICheck size={13} /> Valid
                  </span>
                </div>
              </div>

              <GroupLabel n={3}>About</GroupLabel>
              <div className="flex flex-col">
                {[
                  'Documentation',
                  'Report an issue',
                  'Privacy — your key never leaves this device',
                ].map((l) => (
                  <a
                    key={l}
                    href="#"
                    className="dz-t flex items-center gap-[8px] rounded-[8px] px-[2px] py-[8px] text-[13px] leading-[1.4] text-[var(--dz-fg-body)] hover:text-[var(--dz-fg-strong)]"
                  >
                    <span className="text-[var(--dz-fg-muted)]">
                      <ILink size={13} />
                    </span>
                    <span className="min-w-0 flex-1">{l}</span>
                    <span className="text-[var(--dz-fg-muted)]">
                      <IExternal size={12} />
                    </span>
                  </a>
                ))}
                <button
                  type="button"
                  className="dz-t mt-[6px] flex h-[28px] w-fit items-center rounded-[9999px] border border-[var(--dz-border-strong)] px-[10px] text-[12px] font-medium text-[var(--dz-fg)]"
                >
                  Replay onboarding
                </button>
              </div>
            </div>
          </Frame>

          <Frame caption="Settings — Custom base URL, combobox open, saving" height={420}>
            <div className="px-[16px] py-[12px]">
              <div className="flex flex-col gap-[10px]">
                <label className="flex flex-col gap-[4px]">
                  <span className="text-[11px] leading-[1.4] font-medium text-[var(--dz-fg-muted)]">
                    Preset
                  </span>
                  <span className="dz-t flex h-[32px] items-center rounded-[8px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-inset)] px-[8px]">
                    <span className="flex-1 text-[12px] text-[var(--dz-fg)]">Custom</span>
                    <IChevDown size={12} />
                  </span>
                </label>
                <Field label="Base URL" value="http://127.0.0.1:11434/v1" mono />
                <Field label="API key" placeholder="Paste your key" type="password" />
                <Combobox mode="open" />
                <div className="mt-[54px] flex items-center gap-[8px]">
                  <button
                    type="button"
                    disabled
                    className="dz-t flex h-[32px] items-center gap-[6px] rounded-[9999px] px-[14px] text-[13px] font-semibold opacity-70"
                    style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
                  >
                    <ISpinner size={13} /> Saving…
                  </button>
                </div>
              </div>
            </div>
          </Frame>

          <Frame caption="Settings — pasted unknown model, invalid save" height={300}>
            <div className="px-[16px] py-[12px]">
              <Combobox mode="unknown" />
              <div className="mt-[14px] flex items-center gap-[8px]">
                <button
                  type="button"
                  className="dz-t flex h-[32px] items-center rounded-[9999px] px-[14px] text-[13px] font-semibold"
                  style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
                >
                  Save
                </button>
                <span className="flex items-center gap-[5px] text-[12px] text-[var(--dz-status-error)]">
                  <IWarn size={13} /> Invalid
                </span>
              </div>
              <p
                className="dz-wrap mt-[8px] rounded-[8px] px-[8px] py-[6px] text-[11px] leading-[1.4]"
                style={{ background: 'var(--dz-error-fill)', color: 'var(--dz-status-error)' }}
              >
                Endpoint replied 404 for model my-org/private-tune-2b. Check the id or the base URL.
              </p>
            </div>
          </Frame>

          {/* ---------------- onboarding ---------------- */}
          <SectionHeading n="08" title="Onboarding" note="Three steps over a scrim, skippable." />

          {[
            {
              i: 0,
              t: 'Add your AI provider',
              b: 'Paste a key from OpenRouter, OpenAI, or point Designer at a local endpoint. It stays on this device.',
            },
            {
              i: 1,
              t: 'Connect a backend',
              b: 'Optional. With an MCP backend connected, Ship opens a real pull request instead of downloading a brief.',
            },
            {
              i: 2,
              t: 'Make your first edit',
              b: 'Pin an element with the picker, describe the change, and watch the page update beside you.',
            },
          ].map((s) => (
            <Frame key={s.i} caption={`Onboarding — step ${s.i + 1} of 3`} height={420}>
              <div className="relative h-full">
                <Header state="setup" disabled />
                <TabStrip />
                <div className="absolute inset-0" style={{ background: 'var(--dz-scrim)' }} />
                <div className="absolute inset-x-[16px] top-[72px]">
                  <div className="rounded-[16px] border border-[var(--dz-border-subtle)] bg-[var(--dz-elev-card)] p-[14px] shadow-[0_24px_48px_rgba(0,0,0,.6)]">
                    <div className="flex items-center gap-[6px]">
                      {[0, 1, 2].map((d) => (
                        <span
                          key={d}
                          className="h-[3px] flex-1 rounded-[9999px]"
                          style={{
                            background: d <= s.i ? 'var(--dz-accent)' : 'var(--dz-elev-inset)',
                          }}
                        />
                      ))}
                    </div>
                    <p className="dz-mono mt-[12px] text-[11px] text-[var(--dz-fg-muted)]">
                      Step {s.i + 1} of 3
                    </p>
                    <h3 className="mt-[4px] text-[17px] leading-[1.25] font-semibold text-[var(--dz-fg-strong)]">
                      {s.t}
                    </h3>
                    <p className="mt-[6px] text-[13px] leading-[1.55] text-[var(--dz-fg-body)]">
                      {s.b}
                    </p>
                    <div className="mt-[16px] flex items-center gap-[6px]">
                      {s.i > 0 ? (
                        <button
                          type="button"
                          className="dz-hit dz-t h-[32px] rounded-[9999px] px-[12px] text-[13px] font-medium text-[var(--dz-fg-muted)] hover:text-[var(--dz-fg)]"
                        >
                          Back
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="dz-t ml-auto flex h-[32px] items-center gap-[6px] rounded-[9999px] px-[14px] text-[13px] font-semibold"
                        style={{ background: 'var(--dz-accent)', color: 'var(--dz-accent-fg)' }}
                      >
                        {s.i === 2 ? 'Finish' : 'Next'}
                      </button>
                      <button
                        type="button"
                        className="dz-hit dz-t h-[32px] rounded-[9999px] px-[10px] text-[13px] font-medium text-[var(--dz-fg-muted)] hover:text-[var(--dz-fg)]"
                      >
                        Skip
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </Frame>
          ))}
        </div>

        <footer className="mt-[32px] max-w-[70ch] border-t border-[var(--dz-border-subtle)] pt-[16px]">
          <p className="text-[12px] leading-[1.55] text-[var(--dz-fg-muted)]">
            Trade-off decisions are listed in the comment block at the foot of this file.
          </p>
        </footer>
      </main>
    </>
  );
}

/* ==================================================================
   DECISIONS FORCED BY THE CONSTRAINTS — one line each

   1. Five element chips at 360px: 1–3 chips wrap inline; 4+ collapse to a single
      "5 elements ⌄" chip carrying stacked [1][2][3] index squares, which expands
      in place into a wrapping block ABOVE the composer — the composer never moves.
   2. Chip labels are human names truncated at 136px; the raw selector is revealed
      on tap into an inset mono line under the chip (and via title= on hover), so a
      120-char selector can never widen the panel.
   3. Twelve tool chips: a "12 actions ⌄" group header collapses the run but always
      keeps the running chip and any errored chip visible, and expands into the
      thread's own scroller rather than growing a nested one.
   4. Tool chip layout is icon + mono name + kind badge + truncated summary on one
      28px row; only chips carrying a selector are expandable, so the chevron column
      is meaningful rather than decorative.
   5. Ship bar at 360px: primary "Ship" flexes to fill, "Download brief" and
      "Send to…" become 36px icon-only ghosts with aria-label + title; the Send menu
      opens upward so it never collides with the composer.
   6. Mixed tab strip: text tabs are flex-1, icon tabs are fixed 36px squares with
      aria-label/title and an active accent underline — no leading icons on text tabs,
      which would cost ~40px each that 360px cannot pay. The changeset tab carries a
      count badge, which is the only affordance that hints at what the icon means.
   7. Single-scroller contract: every frame has exactly one .dz-scroll region; the
      thread scrolls, everything else is docked. Only popovers (model menu, combobox)
      scroll internally, and scrollbars use scrollbar-gutter:stable so no layout shift.
   8. Readiness check rows stack detail BELOW the label, so "nvidia.com is not in the
      allow list" wraps instead of truncating the label it belongs to.
   9. The 8th readiness row is a switch, visually separated by a hairline so it does
      not read as an 8th pass/fail check.
  10. Before/after diff is two stacked rows in one inset well with −/+ gutter glyphs,
      not side-by-side columns: 328px cannot hold two wrapping mono values.
  11. Model quick-switch is quiet text + chevron with no border, since a second border
      inside the composer shell reads as a nested field.
  12. Composer textarea grows 1 → 6 rows (max-height 132px ≈ 40% of an 800px panel)
      before scrolling internally, which keeps the thread's last turn visible.
  13. One circular 32px button in the send slot swaps identity (accent ↑ / outlined ■)
      rather than ever showing Send and Stop side by side.
  14. "Running…" uses the green check, not a spinner — a live session is a state; the
      only spinner in the header-adjacent area is on in-flight work itself.
  15. Hover vs pinned rectangles are distinguished by weight, not hue: hover is a 1px
      dashed accent hairline with no fill, pinned is 2px solid accent with a 10% fill.
      Fragile shifts hue to amber and keeps the dash, so all three read at a glance.
  16. Every 28px control gets a transparent 44px pointer area via .dz-hit::after, so
      the dense layout still meets target-size guidance.
  17. Borders that are the only affordance (secondary buttons, switch track) use
      --dz-border-strong; borders decorating a control that already shows text/icon
      use --dz-border-subtle.
  18. Added tokens, all derived: --dz-accent-fill / --dz-accent-line (reference rects
      and chips), --dz-warn-fill / --dz-warn-line (fragile), --dz-error-fill,
      --dz-ok-fill, plus --dz-font-sans / --dz-font-mono system stacks.
  ================================================================== */
