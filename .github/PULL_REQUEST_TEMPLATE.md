<!-- Keep it small and single-responsibility. -->

## What

<!-- One or two lines: what changed and why. -->

## How

<!-- Approach, notable decisions. Which world(s) does this touch? SW / content / panel. -->

## Checklist

- [ ] `bun run lint` clean
- [ ] `bun run typecheck` clean
- [ ] `bun run test:unit` + `bun run test:integration` green
- [ ] New module → unit test; new cross-world flow → integration test
- [ ] MV3 boundaries respected — no keys/tokens in the content script, no DOM in the service worker
- [ ] SolidJS SRP — component has co-located `.scss`, no logic in components
- [ ] No secrets committed (BYOK)
- [ ] Docs updated if behavior/architecture changed

## Screenshots / notes

<!-- Optional. For UI changes, before/after. -->
