/**
 * Home Assistant's sidebar, under its ingress. With the app's `hide_sidebar`
 * option, which the server passes in a meta tag, Home Assistant's kiosk mode
 * hides its sidebar and header around the page, and the app bar's menu
 * button opens the sidebar over the page. On a phone, where that button
 * opens the bar's own menu, the sidebar is an item in it instead.
 */
import { createIcon } from "@timmo001/groundwork-ui";
import { Schema } from "effect";
import { phHouse } from "./icons.ts";

const isProperties = Schema.is(
  Schema.Struct({ type: Schema.Literal("home-assistant/properties") }),
);

/** Whether a click was on the app bar's own menu button, in its shadow root. */
const onMenuButton = (event: Event) =>
  event
    .composedPath()
    .some(
      (node) => node instanceof Element && node.getAttribute("part") === "menu",
    );

/**
 * Wires the sidebar to the app bar and its item in the bar's menu, calling
 * `shown` once the bar's menu button opens the sidebar on wide screens. The
 * button only shows once Home Assistant answers, so an older one that
 * ignores kiosk mode keeps its own header and doesn't get two. Home
 * Assistant keeps kiosk mode across a reload of the page, so with the option
 * off the page leaves it.
 */
export const homeAssistantSidebar = (
  appBar: HTMLElementTagNameMap["gw-app-bar"],
  item: HTMLButtonElement,
  shown: () => void,
) => {
  const option = document.querySelector(
    'meta[name="kestrel-home-assistant-sidebar"]',
  );

  if (!(option instanceof HTMLMetaElement) || window.parent === window) return;

  if (option.content !== "hide") {
    window.parent.postMessage(
      { type: "home-assistant/unsubscribe-properties" },
      "*",
    );

    return;
  }

  const toggle = () => {
    window.parent.postMessage({ type: "home-assistant/toggle-menu" }, "*");
  };

  item.prepend(createIcon(phHouse));

  item.addEventListener("click", () => {
    appBar.toggleMenu(false);
    toggle();
  });

  // Ahead of the button's own listener, so on wide screens it opens the
  // sidebar rather than the bar's menu
  appBar.addEventListener(
    "click",
    (event) => {
      if (
        !appBar.hasAttribute("data-ha-sidebar") ||
        appBar.collapsed ||
        !onMenuButton(event)
      ) {
        return;
      }

      event.stopPropagation();
      toggle();
    },
    { capture: true },
  );

  // The button's name follows what it opens
  const label = () => {
    appBar.menuLabel = appBar.collapsed ? "Menu" : "Home Assistant sidebar";
  };

  new MutationObserver(label).observe(appBar, {
    attributes: true,
    attributeFilter: ["collapsed"],
  });

  label();

  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      !isProperties(event.data) ||
      appBar.hasAttribute("data-ha-sidebar")
    ) {
      return;
    }

    appBar.toggleAttribute("data-ha-sidebar", true);
    item.hidden = false;
    shown();
  });

  window.parent.postMessage(
    { type: "home-assistant/subscribe-properties", kioskMode: true },
    "*",
  );
};
