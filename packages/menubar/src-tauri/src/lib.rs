//! Menu bar widget.
//!
//! Deliberately thin: all the numbers come from the local collector's HTTP
//! API (`/api/tray` for the menu bar title, `/widget` for the popover UI), so
//! the native layer only has to (1) draw a tray item, (2) show/hide a small
//! always-on-top window under it, and (3) keep the collector alive.

use std::{
    process::{Child, Command},
    sync::Mutex,
    thread,
    time::Duration,
};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_positioner::{Position, WindowExt};

/// Monochrome template icon (macOS tints it for light/dark menu bars).
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-icon@2x.png");
const POLL_SECS: u64 = 20;

/// The collector child process, if this app started it (so Quit stops it).
struct Collector(Mutex<Option<Child>>);

#[derive(serde::Deserialize, Debug, Default)]
struct TrayInfo {
    title: String,
    #[serde(default)]
    severity: String,
    /// Which window the number is about. With several providers connected the
    /// tray shows whichever is fullest, so the tooltip must name it.
    #[serde(default)]
    label: Option<String>,
}

fn port() -> String {
    std::env::var("AI_USAGE_WIDGET_PORT").unwrap_or_else(|_| "4321".into())
}

fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

fn get_json<T: serde::de::DeserializeOwned>(path: &str) -> Option<T> {
    ureq::get(&format!("{}{}", base_url(), path))
        .timeout(Duration::from_secs(3))
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn collector_alive() -> bool {
    ureq::get(&format!("{}/api/health", base_url()))
        .timeout(Duration::from_secs(2))
        .call()
        .is_ok()
}

/// Start `ai-usage-widget serve --no-open` if nothing answers on the port.
/// GUI apps on macOS get a minimal PATH, so common install locations are
/// tried explicitly; `AI_USAGE_WIDGET_BIN` overrides everything.
fn spawn_collector() -> Option<Child> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(bin) = std::env::var("AI_USAGE_WIDGET_BIN") {
        candidates.push(bin);
    }
    candidates.push("ai-usage-widget".into());
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        candidates.push(format!("{dir}/ai-usage-widget"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.npm-global/bin/ai-usage-widget"));
        candidates.push(format!("{home}/.local/bin/ai-usage-widget"));
    }
    for bin in candidates {
        if let Ok(child) = Command::new(&bin)
            .args(["serve", "--no-open", &format!("--port={}", port())])
            .spawn()
        {
            eprintln!("[menubar] started collector via {bin}");
            return Some(child);
        }
    }
    eprintln!("[menubar] could not start collector; is ai-usage-widget installed globally?");
    None
}

fn toggle_popover(app: &AppHandle) {
    let Some(win) = app.get_webview_window("popover") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        // Positioned relative to the tray icon (positioner tracks its rect).
        let _ = win.move_window(Position::TrayBottomCenter);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn update_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    match get_json::<TrayInfo>("/api/tray") {
        Some(info) => {
            let prefix = match info.severity.as_str() {
                "critical" => "⚠ ",
                "warning" => "! ",
                _ => "",
            };
            let _ = tray.set_title(Some(format!("{prefix}{}", info.title)));
            let tip = match &info.label {
                Some(l) => format!("{l} — click for details"),
                None => "AI Usage Widget — click for details".to_string(),
            };
            let _ = tray.set_tooltip(Some(tip));
        }
        None => {
            let _ = tray.set_title(Some("--"));
            let _ = tray.set_tooltip(Some("AI Usage Widget — collector not running"));
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Collector(Mutex::new(None)))
        .setup(|app| {
            // Menu-bar-only app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit AI Usage Widget", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(TRAY_ICON)?)
                .icon_as_template(true)
                .title("…")
                .tooltip("AI Usage Widget")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let _ = app.opener().open_url(base_url(), None::<&str>);
                    }
                    "refresh" => update_tray(app),
                    "quit" => {
                        if let Some(child) = app.state::<Collector>().0.lock().ok().and_then(|mut c| c.take()) {
                            let mut child = child;
                            let _ = child.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_popover(tray.app_handle());
                    }
                })
                .build(app)?;

            // Keep the collector alive and the title fresh.
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                if !collector_alive() {
                    if let Ok(mut slot) = handle.state::<Collector>().0.lock() {
                        let dead = slot.as_mut().map(|c| c.try_wait().map(|s| s.is_some()).unwrap_or(true)).unwrap_or(true);
                        if dead {
                            *slot = spawn_collector();
                        }
                    }
                    // give it a moment to bind the port before the first poll
                    thread::sleep(Duration::from_secs(2));
                }
                update_tray(&handle);
                thread::sleep(Duration::from_secs(POLL_SECS));
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Popover behaviour: clicking anywhere else dismisses it.
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Usage Widget");
}
