import { createEffect, createMemo, mergeProps } from 'solid-js';
import type { IconName, IconSize } from './icon-registry';
import { buildIconClass, buildIconSvg } from './icon-registry';
import './Icon.scss';

export type { IconName, IconSize } from './icon-registry';

export interface IconProps {
  name: IconName;
  size?: IconSize;
  spin?: boolean;
  class?: string;
}

// Presentational only (CLAUDE.md "SolidJS + SRP" — no business logic in components).
// Icon lookup + SVG-tree construction live in ./icon-registry (no `innerHTML`, nothing
// fetched at runtime); this component just mounts the resulting DOM node into a host
// span and maps size/spin to classes styled in Icon.scss (tokens only, never a bare
// hex/px — CLAUDE.md "SCSS").
export function Icon(rawProps: IconProps) {
  const props = mergeProps({ size: 'md' as IconSize, spin: false }, rawProps);
  let host: HTMLSpanElement | undefined;

  const hostClass = createMemo(() =>
    buildIconClass({ size: props.size, spin: props.spin, class: props.class }),
  );

  createEffect(() => {
    const svg = buildIconSvg(props.name);
    host?.replaceChildren(svg);
  });

  return <span ref={host} class={hostClass()} aria-hidden="true" />;
}
