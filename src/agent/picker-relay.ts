// The SW half of the user-driven element picker: forward one PickerCmd to the target tab's content
// script and report whether it landed. A failed send (no content script — a tab open since before
// the extension was installed/reloaded, a chrome:// page, a tab mid-navigation) used to be
// swallowed into `{ ok: true }`, so the panel's ok-checks could never fire and the picker button
// claimed to be armed on a page where nothing would ever pick.
//
// The send is injected (chrome-free), so the outcome mapping is unit-testable.

import type { OkResult, PickerCmd } from '@/shared/messages';

export type SendPickerCmd = (tabId: number, cmd: PickerCmd) => Promise<unknown>;

/** Send `cmd` to `tabId`'s top frame; `{ ok: false, error }` (an actionable sentence) on failure. */
export async function relayPickerCmd(
  send: SendPickerCmd,
  tabId: number,
  cmd: PickerCmd,
): Promise<OkResult> {
  try {
    await send(tabId, cmd);
    return { ok: true };
  } catch (err) {
    const message = String(err);
    if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
      return {
        ok: false,
        error:
          'The element picker cannot reach this page — it was open before the extension was ' +
          'installed or updated, or it does not allow extensions. Reload the page (F5) and retry.',
      };
    }
    return { ok: false, error: `The element picker could not reach this page: ${message}` };
  }
}
