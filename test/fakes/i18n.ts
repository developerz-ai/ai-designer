// Test double for the `#i18n` module (@wxt-dev/i18n), wired via a Vitest `resolve.alias`.
//
// The real module resolves messages through `browser.i18n.getMessage`, i.e. globalThis
// chrome/browser — which the unit/integration fakes replace wholesale per test. Depending
// on that global would make `i18n.t()` fragile (a fake that omits `i18n` breaks any code
// path that renders a localized string). Instead this double reads the messages directly
// from src/locales/en.yml (via @wxt-dev/i18n's own build parser) and reproduces `t()`
// exactly, so localized strings resolve to real English independent of any chrome fake.
// The `t()` logic below is ported 1:1 from @wxt-dev/i18n's createI18n().
import { generateChromeMessages, parseMessagesFile } from '@wxt-dev/i18n/build';

// cwd is the project root under `bun run test`.
const messages = generateChromeMessages(await parseMessagesFile('src/locales/en.yml'));

// browser.i18n.getMessage equivalent: look up the flat message + apply positional
// $1..$9 substitutions ($$ escapes to a literal $).
function getMessage(name: string, subs?: string[]): string {
  const raw = messages[name]?.message ?? '';
  if (!subs?.length) {
    return raw;
  }
  return raw.replace(/\$(\$|[1-9])/g, (_full, token: string) =>
    token === '$' ? '$' : (subs[Number(token) - 1] ?? ''),
  );
}

function applyNamedSubstitutions(message: string, named: Record<string, string>): string {
  return message.replace(/\{(\w+)\}/g, (full, key: string) => named[key] ?? full);
}

function t(key: string, ...args: unknown[]): string {
  let sub: string[] | undefined;
  let namedSub: Record<string, unknown> | undefined;
  let count: number | undefined;
  for (const arg of args) {
    if (arg == null) {
      continue;
    }
    if (typeof arg === 'number') {
      count = arg;
    } else if (Array.isArray(arg)) {
      sub = arg.map(String);
    } else if (typeof arg === 'object') {
      namedSub = arg as Record<string, unknown>;
    }
  }
  if (count != null && sub == null) {
    sub = [String(count)];
  }

  const name = key.replaceAll('.', '_');
  let message = sub?.length ? getMessage(name, sub) : getMessage(name);

  if (count != null) {
    const plural = message.split(' | ');
    if (plural.length === 2) {
      message = plural[count === 1 ? 0 : 1] ?? message;
    } else if (plural.length === 3) {
      message = plural[count === 0 || count === 1 ? count : 2] ?? message;
    } else {
      message = plural[0] ?? message;
    }
  }

  if (namedSub != null) {
    const named: Record<string, string> = {};
    for (const [k, v] of Object.entries(namedSub)) {
      named[k] = String(v);
    }
    message = applyNamedSubstitutions(message, named);
  }

  return message;
}

// Matches the real module's `export const i18n`. Loosely typed on purpose — tsc still
// checks the components against the REAL typed #i18n (via tsconfig paths); this double
// only supplies runtime behavior for tests.
export const i18n = { t };
