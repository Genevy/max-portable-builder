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

// MAX deep links and max.ru landing pages, handled by the Rust side.
// - max://max.ru/<x>       -> open_deep_link (same window, Q3 = A)
// - https://max.ru/<x>     -> open_max_ru    (in-app, Q1 = B → web.max.ru)
// capture: true so it runs before Pake's own click handlers and can
// preventDefault() the anchor navigation before the webview tries it.
function handleMaxLinkClick(event) {
  if (event.defaultPrevented) return;
  const anchor = event.target?.closest?.("a[href]");
  if (!anchor || anchor.hasAttribute("download")) return;
  if (anchor.target && !["_blank", "_new", "_self"].includes(anchor.target))
    return;
  const href = anchor.href;
  if (typeof href !== "string") return;

  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;

  if (href.startsWith("max://")) {
    event.preventDefault();
    event.stopPropagation();
    invoke("open_deep_link", { url: href }).catch((error) =>
      console.error("[MAX] open_deep_link failed:", error),
    );
    return;
  }

  if (href.startsWith("https://max.ru/") || href.startsWith("http://max.ru/")) {
    event.preventDefault();
    event.stopPropagation();
    invoke("open_max_ru", { url: href }).catch((error) =>
      console.error("[MAX] open_max_ru failed:", error),
    );
  }
}

if (typeof window !== "undefined") {
  document.addEventListener("click", handleMaxLinkClick, true);
}