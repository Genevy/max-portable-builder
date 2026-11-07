//! `max://` deep links (registration + parsing) and opening external URLs.
//!
//! Registration is per-user (HKCU\Software\Classes\max), no UAC required,
//! and reversible with a single `reg delete` if needed. It only claims the
//! `max:` scheme; nothing else in the registry is touched.
//!
//! Behaviour (agreed with the user):
//! - `max://max.ru/<path>`  -> navigate the current window to
//!   `https://web.max.ru/<path>` (same window, Q3 = A).
//! - `https://max.ru/<path>` -> open in the current window as
//!   `https://web.max.ru/<path>` (Q1 = B, in-app, no landing page).

use tauri::{AppHandle, Manager, Url, WebviewWindow};

/// The `max://` links the MAX landing page emits look like
/// `max://max.ru/<channel>`; the real web app lives at
/// `https://web.max.ru/<channel>`.
const DEEP_LINK_HOST: &str = "max.ru";
const DEEP_LINK_WEB_PREFIX: &str = "https://web.max.ru/";

/// Register `max://` for the current executable in HKCU, so Windows hands
/// `max://...` URLs to MAX Portable instead of doing nothing.
///
/// Windows-only; on other platforms this is a no-op. Best-effort: errors
/// are logged and never abort startup (a missing registration only means
/// clicking `max://` in a browser keeps doing nothing until the next run
/// with the needed permissions).
#[cfg(windows)]
pub fn register_protocol() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[MAX] deep_link: cannot resolve current exe: {error}");
            return;
        }
    };
    let exe_str = exe.to_string_lossy().to_string();
    let command = format!("\"{exe_str}\" \"%1\"");

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let result: std::io::Result<()> = (|| {
        let (key, _) = hkcu.create_subkey("Software\\Classes\\max")?;
        key.set_value("", &"URL:max Protocol".to_string())?;
        key.set_value("URL Protocol", &"".to_string())?;
        let (icon, _) = key.create_subkey("DefaultIcon")?;
        icon.set_value("", &format!("{exe_str},0"))?;
        let (shell, _) = key.create_subkey("shell")?;
        let (open, _) = shell.create_subkey("open")?;
        let (cmd, _) = open.create_subkey("command")?;
        cmd.set_value("", &command)?;
        Ok(())
    })();

    match result {
        Ok(()) => println!("[MAX] deep_link: max:// registered for {exe_str}"),
        Err(error) => eprintln!("[MAX] deep_link: failed to register max://: {error}"),
    }
}

#[cfg(not(windows))]
pub fn register_protocol() {}

/// Turn a `max://` URL into the equivalent `https://web.max.ru/...` URL.
///
/// Returns `None` for anything that is not a well-formed `max://max.ru/...`
/// link, so callers can fall back to "ignore" or "open externally".
///
/// Examples:
/// - `max://max.ru/example_channel`   -> `Some("https://web.max.ru/example_channel")`
/// - `max://max.ru/example_channel/`  -> `Some("https://web.max.ru/example_channel/")`
/// - `max://other.host/x`             -> `None`
/// - `https://max.ru/x`               -> `None` (handled elsewhere, Q1 = B)
pub fn parse_deep_link(url: &str) -> Option<String> {
    let rest = url.strip_prefix("max://")?;
    let (host, path) = match rest.split_once('/') {
        Some((host, path)) => (host, path),
        None => (rest, ""),
    };
    if !host.eq_ignore_ascii_case(DEEP_LINK_HOST) {
        return None;
    }
    Some(format!("{DEEP_LINK_WEB_PREFIX}{path}"))
}

/// Turn `https://max.ru/<path>` (landing page for a channel/group/
/// profile/post) into the equivalent `https://web.max.ru/<path>` URL,
/// so MAX's own SPA opens it in-app instead of showing the landing page
/// or bouncing the user to the system browser. Returns `None` for
/// anything that is not a `http(s)://max.ru/...` URL.
pub fn max_ru_to_web(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.trim_start_matches("www.");
    if !host.eq_ignore_ascii_case(DEEP_LINK_HOST) {
        return None;
    }
    let mut rest = parsed.path().trim_start_matches('/').to_string();
    if let Some(query) = parsed.query() {
        rest.push('?');
        rest.push_str(query);
    }
    if let Some(fragment) = parsed.fragment() {
        rest.push('#');
        rest.push_str(fragment);
    }
    Some(format!("{DEEP_LINK_WEB_PREFIX}{rest}"))
}

/// If MAX Portable was launched with a `max://...` argument, return it.
///
/// Windows passes the URL as the first positional argument when the shell
/// opens our registered protocol handler (`"MaxPortable.exe" "max://..."`).
/// Other flags (`--flag=value`, `--dark-mode`, etc.) are ignored; Pake's
/// own argument parsing is untouched.
pub fn pending_deep_link() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| arg.starts_with("max://"))
}

/// Navigate the main window to `url`. Falls back to doing nothing if the
/// window is gone for any reason.
fn navigate_main_window(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("pake") else {
        eprintln!("[MAX] deep_link: main window not found, ignoring {url}");
        return;
    };
    navigate_window(&window, url);
}

/// Navigate a specific window, bringing it to the foreground first so that
/// a deep link from a browser visibly lands on the channel.
pub fn navigate_window(window: &WebviewWindow, url: &str) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    match url.parse() {
        Ok(parsed) => {
            if let Err(error) = window.navigate(parsed) {
                eprintln!("[MAX] navigate_window failed: {error}");
            }
        }
        Err(error) => eprintln!("[MAX] navigate_window invalid URL {url}: {error}"),
    }
}

/// Handle a `max://...` URL coming from the OS (startup argument) or from
/// the page (intercepted click). `max://max.ru/<x>` navigates the current
/// window to `https://web.max.ru/<x>`; anything else is ignored.
pub fn handle_deep_link(app: &AppHandle, url: &str) {
    let Some(web_url) = parse_deep_link(url) else {
        eprintln!("[MAX] deep_link: ignoring unsupported deep link: {url}");
        return;
    };
    navigate_main_window(app, &web_url);
}

/// Open `https://max.ru/<x>` (or any other `http(s)` URL) in the system
/// browser. Used for Q1 = B: MAX landing pages stay out of the app.
pub fn open_external_url(url: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{max_ru_to_web, parse_deep_link};

    #[test]
    fn parses_channel_link() {
        assert_eq!(
            parse_deep_link("max://max.ru/example_channel").as_deref(),
            Some("https://web.max.ru/example_channel")
        );
    }

    #[test]
    fn parses_trailing_slash() {
        assert_eq!(
            parse_deep_link("max://max.ru/example_channel/").as_deref(),
            Some("https://web.max.ru/example_channel/")
        );
    }

    #[test]
    fn parses_empty_path() {
        assert_eq!(
            parse_deep_link("max://max.ru").as_deref(),
            Some("https://web.max.ru/")
        );
    }

    #[test]
    fn rejects_other_hosts() {
        assert_eq!(parse_deep_link("max://other.host/x"), None);
        assert_eq!(parse_deep_link("max://evil/max.ru"), None);
    }

    #[test]
    fn rejects_non_max_scheme() {
        assert_eq!(parse_deep_link("https://max.ru/example_channel"), None);
        assert_eq!(parse_deep_link("maxx://max.ru/x"), None);
    }

    #[test]
    fn host_is_case_insensitive() {
        assert_eq!(
            parse_deep_link("max://MAX.RU/example_channel").as_deref(),
            Some("https://web.max.ru/example_channel")
        );
    }

    #[test]
    fn max_ru_to_web_converts_https() {
        assert_eq!(
            max_ru_to_web("https://max.ru/example_channel").as_deref(),
            Some("https://web.max.ru/example_channel")
        );
    }

    #[test]
    fn max_ru_to_web_converts_http() {
        assert_eq!(
            max_ru_to_web("http://max.ru/example_channel").as_deref(),
            Some("https://web.max.ru/example_channel")
        );
    }

    #[test]
    fn max_ru_to_web_converts_bare_domain_and_www() {
        assert_eq!(
            max_ru_to_web("https://max.ru").as_deref(),
            Some("https://web.max.ru/")
        );
        assert_eq!(
            max_ru_to_web("https://www.max.ru/example_channel").as_deref(),
            Some("https://web.max.ru/example_channel")
        );
    }

    #[test]
    fn max_ru_to_web_keeps_query_and_fragment() {
        assert_eq!(
            max_ru_to_web("https://max.ru/example_channel?start=1#post-2").as_deref(),
            Some("https://web.max.ru/example_channel?start=1#post-2")
        );
    }

    #[test]
    fn max_ru_to_web_rejects_other_hosts() {
        assert_eq!(max_ru_to_web("https://example.com/x"), None);
        assert_eq!(max_ru_to_web("https://web.max.ru/x"), None);
        assert_eq!(max_ru_to_web("max://max.ru/x"), None);
    }
}