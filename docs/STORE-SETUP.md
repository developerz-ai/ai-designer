# Store setup — what to create, what to hand over

Everything CI needs to publish, and who has to click what. Nothing here is in the repo:
each item ends as a **GitHub Actions secret** (`gh secret set <NAME>`).

Related: [RELEASING.md](./RELEASING.md) for how a tag turns into a build.

## Secrets, at a glance

| Secret | Store | Where it comes from | Set? |
|--|--|--|--|
| `CRX_PRIVATE_KEY` | self-hosted `.crx` | `keys/designer.pem` from the first local build — **ours, not a store's** | ✅ |
| `CWS_EXTENSION_ID` | Chrome | the item's ID, after the first manual upload | |
| `CWS_CLIENT_ID` | Chrome | Google Cloud OAuth client (Desktop app) | |
| `CWS_CLIENT_SECRET` | Chrome | same OAuth client | |
| `CWS_REFRESH_TOKEN` | Chrome | one-time consent flow against that client | |
| `AMO_JWT_ISSUER` | Firefox | AMO Developer Hub → API keys | |
| `AMO_JWT_SECRET` | Firefox | same page, shown **once** | |

## 1. Signing key — **done**, but see the backup note

```bash
bun run build                     # generates keys/designer.pem on first run
bun run crx:id                    # the extension id this key produces
gh secret set CRX_PRIVATE_KEY < keys/designer.pem
```

Status: `CRX_PRIVATE_KEY` is set on the repo (2026-07-31). Its extension ID —
**`cmedikfcignmlchbfhliepgkafoopceh`** — is the fingerprint: any restored copy of the PEM
is the right one iff `bun run crx:id` prints that string.

> **A repo secret is not a backup.** GitHub secrets are write-only: once set, nobody —
> not you, not CI logs, not the API — can read the value back. It is safe for Actions to
> *use*, and useless for recovery. The only real backup is `keys/designer.pem` itself, in a
> password manager or secret store, kept off git.
>
> Lose the PEM and every self-hosted install becomes a different extension, and the
> `https://<id>.chromiumapp.org/` OAuth redirect registered with any MCP provider stops
> matching (`src/mcp/auth.ts`). The Chrome Web Store is unaffected — it assigns its own key.

## 2. Chrome Web Store

**Account.** A Google account — use a shared/team one, not a personal login; the account
owns the listing and moving it later is painful. Register at
[chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).
**One-time $5 USD** registration fee, card required. To publish under "Developerz.ai"
rather than an email address, verify the domain in the console's account settings.

**Create the item.** Upload `bun run zip:store` output manually once. The store then shows
the **Item ID** → `CWS_EXTENSION_ID`. From then on CI can push updates to it.

**API credentials.** In [Google Cloud Console](https://console.cloud.google.com):

1. Create (or pick) a project.
2. APIs & Services → Library → enable **Chrome Web Store API**.
3. OAuth consent screen → External → fill app name + support email → **Publish** it.
   Leave it in *Testing* and the refresh token silently expires after 7 days, which shows
   up as a release failing weeks later for no visible reason.
4. Credentials → Create credentials → **OAuth client ID** → type **Desktop app**.
   → `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`.
5. Trade a one-time consent code for a refresh token (scope
   `https://www.googleapis.com/auth/chromewebstore`) → `CWS_REFRESH_TOKEN`.
   `bunx chrome-webstore-upload-keys` walks this interactively.

**Listing content someone has to write:** description, category, 128×128 icon (have it),
1–5 screenshots at 1280×800 or 640×400, a **privacy policy URL**, and a justification for
every permission.

> **Review risk, worth knowing before you file.** This extension requests `debugger` (25
> call sites — CDP device emulation) and optional `<all_urls>`. `debugger` is one of the
> most scrutinised permissions in the store and routinely triggers extended manual review.
> The justification should say plainly: CDP `Emulation.setDeviceMetricsOverride` for device
> emulation, service-worker only, never exposed to the page. Also expect questions about
> BYOK key handling — the answer is `chrome.storage.local`, encrypted, service worker only,
> no remote code (`docs/architecture/`).

## 3. Firefox Add-ons (AMO)

**Account.** A Firefox Account → [addons.mozilla.org](https://addons.mozilla.org) →
Developer Hub. **No fee.**

**API credentials.** Developer Hub → *Manage API Keys* → generate. You get a **JWT issuer**
(`AMO_JWT_ISSUER`) and a **JWT secret** (`AMO_JWT_SECRET`, displayed once — copy it then).
AMO signs the `.xpi` on its side, so there is no key to keep.

> **The Firefox target is not shippable yet — this is a code gap, not a credentials gap.**
> `bun run build:firefox` produces a valid MV2 zip, but the extension leans on three APIs
> Firefox does not implement the same way:
>
> | Used | Firefox reality |
> |--|--|
> | `chrome.sidePanel` (4 sites) — the entire UI surface | no such API; Firefox has `sidebarAction` |
> | `chrome.debugger` (25 sites) — device emulation | does not exist |
> | `chrome.identity.launchWebAuthFlow` (9 sites) — MCP OAuth | exists, different redirect host |
>
> The manifest also has no `browser_specific_settings.gecko.id`, so AMO cannot pin a stable
> add-on ID. Treat Firefox as its own piece of work: port the panel to `sidebarAction`,
> drop or feature-gate the debugger tools, add the gecko ID. Getting the AMO account and
> API keys now is still worth it — it reserves the add-on name.

## 4. Hand-over checklist

Once the accounts exist, what I need from you is just these, as repo secrets:

```bash
gh secret set CRX_PRIVATE_KEY < keys/designer.pem   # done
gh secret set CWS_EXTENSION_ID
gh secret set CWS_CLIENT_ID
gh secret set CWS_CLIENT_SECRET
gh secret set CWS_REFRESH_TOKEN
gh secret set AMO_JWT_ISSUER     # when Firefox is actually ready
gh secret set AMO_JWT_SECRET
```

The publish step in `.github/workflows/release.yml` is live and **guarded on
`CWS_EXTENSION_ID` being set**: the moment the four `CWS_*` secrets exist, the next tag
uploads to the store and auto-publishes. Until then a tag builds, signs, and attaches
artifacts to a GitHub Release only — which is the right state for manual QA. No workflow
edit needed when the secrets land.

## 5. Dry-run the upload (before trusting a tag)

Validates the credentials and the zip against the real Web Store API **without
publishing** — the upload lands as a draft you can discard in the dev console:

```bash
bun run zip:store
bunx chrome-webstore-upload-cli@3 upload \
  --source build/*-chrome.zip \
  --extension-id "$CWS_EXTENSION_ID" \
  --client-id "$CWS_CLIENT_ID" \
  --client-secret "$CWS_CLIENT_SECRET" \
  --refresh-token "$CWS_REFRESH_TOKEN"
```

No `--auto-publish` = upload only. Check the item shows the new version as a draft in the
[dev console](https://chrome.google.com/webstore/devconsole), then discard or submit it by
hand. Two failure modes worth knowing: `invalid_grant` = the refresh token died (consent
screen left in *Testing*, or token unused for six months) — re-run the consent flow;
`ITEM_NOT_UPDATABLE` = the item is stuck in a pending review, wait it out.

## 6. Rollback / unpublish

The Web Store has **no downgrade**: versions only go up, and a published bad version stays
until something higher replaces it.

- **Bad version live** → fix, bump, tag again. That IS the rollback path: re-tag the last
  good code as a higher version (`git checkout v1.4.0 && git tag v1.4.2 && git push origin
  v1.4.2`). Review time applies (usually hours, `debugger` items can take longer).
- **Stop the bleeding now** → dev console → the item → **Unpublish**. Takes the listing
  down for new installs within ~hours; existing installs keep working and keep the
  last-synced version. Republishing later needs no new review if the version didn't change.
- **Catastrophic (leaked secret in a shipped bundle)** → unpublish, rotate the secret, and
  remember installed copies still hold the old bundle — rotation server-side is the only
  real kill switch. (BYOK means the only repo-side secrets in scope are the publish
  credentials themselves — rotate in Google Cloud console.)
- A submitted-but-pending version can be **cancelled** from the dev console without
  affecting the live one.
