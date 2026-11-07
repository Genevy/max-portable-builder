// Shared by the main page and the lightweight subframe bridge.
// Tauri rejects WebKit's empty popup URL before calling our native handler.
function normalizePopupUrl(url) {
  return url === undefined || (typeof url === "string" && !url.trim())
    ? "about:blank"
    : url;
}

// This list intentionally preserves Pake's existing domain routing policy.
const MULTI_PART_PUBLIC_SUFFIXES = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.kr",
  "co.in",
  "com.br",
  "com.cn",
  "com.tw",
  "com.hk",
  "com.sg",
  "github.io",
  "gitlab.io",
  "pages.dev",
];

function getRootDomain(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (!normalized) return "";
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 1) return normalized;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_PUBLIC_SUFFIXES.includes(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

function createInternalUrlMatcher(pattern) {
  let regex = null;
  if (pattern) {
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      console.error("[Pake] Invalid internal_url_regex pattern:", error);
    }
  }
  return (url, baseUrl) => {
    if (regex) return regex.test(url);
    try {
      const target = new URL(url);
      const current = new URL(baseUrl);
      return (
        target.hostname === current.hostname ||
        getRootDomain(target.hostname) === getRootDomain(current.hostname)
      );
    } catch (error) {
      return false;
    }
  };
}

// Protocol links may represent a web app's compose/contact menu. Let target
// and document handlers cancel them before falling back to the system app.
function handleProtocolLinkClick(event, openExternal) {
  if (event.defaultPrevented) return;
  const anchor = event.target?.closest?.("a[href]");
  if (!anchor || anchor.hasAttribute("download")) return;
  if (anchor.target && !["_blank", "_new", "_self"].includes(anchor.target))
    return;
  if (typeof anchor.href !== "string" || !/^(mailto|tel):/i.test(anchor.href))
    return;
  const url = new URL(anchor.href);
  if (window.pakeConfig?.force_internal_navigation) return;
  if (
    createInternalUrlMatcher(window.pakeConfig?.internal_url_regex)(
      url.href,
      window.pakeConfig?.url || window.location.href,
    )
  )
    return;
  event.preventDefault();
  openExternal(url.href);
}

// MAX deep links and max.ru landing pages, handled before MAX's own router
// sees the click:
// - max://max.ru/<x>   -> https://web.max.ru/<x>
// - https://max.ru/<x> -> https://web.max.ru/<x>
//
// MAX's SPA only routes same-origin links: a cross-origin max.ru anchor is
// either ignored by the router (nothing happens) or sent to the system
// browser. The listener must be on `window` in the capture phase: page
// scripts run after initialization scripts, so this is the first click
// listener on the page and MAX cannot hide the link with stopPropagation()
// or a preventDefault() that runs before a document-level listener.
function maxWebUrlFromHref(href) {
  let url;
  try {
    url = new URL(href, window.location.href);
  } catch (error) {
    return null;
  }
  let rest;
  if (url.protocol === "max:") {
    if (url.hostname.toLowerCase() !== "max.ru") return null;
    rest = url.pathname.replace(/^\//, "");
  } else if (
    (url.protocol === "https:" || url.protocol === "http:") &&
    (url.hostname === "max.ru" || url.hostname === "www.max.ru")
  ) {
    rest = url.pathname.replace(/^\//, "");
  } else {
    return null;
  }
  return `https://web.max.ru/${rest}${url.search}${url.hash}`;
}

// composedPath() also finds an anchor behind an open shadow root, where
// event.target is retargeted to the host element.
function maxAnchorFromEvent(event) {
  if (typeof event.composedPath === "function") {
    for (const node of event.composedPath()) {
      if (node && node.nodeType === 1 && node.matches && node.matches("a[href]")) {
        return node;
      }
    }
  }
  const target = event.target;
  return target && typeof target.closest === "function"
    ? target.closest("a[href]")
    : null;
}

function handleMaxLinkClick(event) {
  const anchor = maxAnchorFromEvent(event);
  if (!anchor || anchor.hasAttribute("download")) return;
  const href = anchor.href;
  if (typeof href !== "string") return;
  const webUrl = maxWebUrlFromHref(href);
  if (!webUrl) return;

  // Claim the click before MAX's router can preventDefault() it and then drop
  // the cross-origin URL, and before Pake can send it to the system browser.
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }

  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    window.location.assign(webUrl);
    return;
  }
  invoke(href.startsWith("max://") ? "open_deep_link" : "open_max_ru", {
    url: href,
  }).catch((error) => {
    console.error("[MAX] native navigation failed, falling back:", error);
    window.location.assign(webUrl);
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("click", handleMaxLinkClick, true);
}