/**
 * The Pair page: where a browser the server doesn't know yet lands. It pairs
 * with a code typed in, or a pairing link pasted in, or straight away with
 * one carried in the address (`#pair=`), as a link or QR code from Settings
 * or `kestrel pair` opens it. The server answers with a cookie this page
 * can't read, then the app starts again as a paired browser.
 */
import {
  parsePairingInput,
  takePairingLink,
} from "@timmo001/groundwork-pwa/pairing";
import { call } from "./api.ts";
import { find } from "./shared.ts";

export interface PairOptions {
  /** Once paired, such as to start the app again. */
  readonly onPaired: () => void;
}

export interface PairPage {
  /** Shows the page, pairing at once with a code in the address. */
  readonly open: () => void;
}

/** What Settings lists this browser as, such as `Browser on Linux x86_64`. */
const browserName = () => `Browser on ${navigator.platform || "this device"}`;

export const pairPage = (options: PairOptions): PairPage => {
  const input = find("gw-input", "pair-code");
  const error = find("gw-alert", "pair-error");
  const submit = find("gw-button", "pair-submit");

  const say = (message: string) => {
    if (error === null) return;

    error.textContent = message;
    error.hidden = message === "";
  };

  /** Pairs with a typed code, or a whole pairing link pasted in. */
  const pair = async (typed: string) => {
    if (typed.trim() === "") {
      say("Type the code first.");

      return;
    }

    const code = parsePairingInput(typed, location.href)?.code ?? typed;

    if (submit !== null) submit.disabled = true;

    say("");

    try {
      await call((api) =>
        api.devices.pair({
          payload: { code, name: browserName(), kind: "browser" },
        }),
      );

      options.onPaired();
    } catch {
      say(
        "That code didn't work: it may be mistyped, used or out of time. Get a new one and try again.",
      );
    } finally {
      if (submit !== null) submit.disabled = false;
    }
  };

  submit?.addEventListener("click", () => void pair(input?.value ?? ""));

  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void pair(input.value);
  });

  return {
    open: () => {
      // Taken out of the address, so it isn't kept in the history or shared on
      const link = takePairingLink();

      if (link === undefined) {
        input?.focus();

        return;
      }

      if (input !== null) input.value = link.code;

      void pair(link.code);
    },
  };
};
