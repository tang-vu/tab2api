mod admin;
mod browser_host;
mod lifecycle;
mod startup;
mod tunnel;

#[cfg(not(test))]
use admin::{ApiKeyList, CreatedApiKey, ExportedApiDocs, SessionReadiness, UsageSnapshot};
#[cfg(not(test))]
use browser_host::BrowserBounds;
#[cfg(not(test))]
use lifecycle::{ServiceStatus, SidecarLifecycle};
#[cfg(not(test))]
use startup::{AUTOSTART_ARG, AUTOSTART_ENTRY_NAME, AutostartStatus, StartupManager};
#[cfg(not(test))]
use std::sync::Arc;
#[cfg(not(test))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(test))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(not(test))]
use tauri::{Manager, State};
#[cfg(not(test))]
use tauri_plugin_autostart::ManagerExt;
#[cfg(not(test))]
use tunnel::{TunnelManager, TunnelStatus};

#[cfg(not(test))]
struct DesktopState {
    lifecycle: Arc<SidecarLifecycle>,
    startup: StartupManager,
    tunnel: Arc<TunnelManager>,
}

#[cfg(not(test))]
fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::AssetNotFound("main window".into()))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

#[cfg(not(test))]
#[tauri::command]
fn autostart_status(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<AutostartStatus, String> {
    let autostart = app.autolaunch();
    state
        .startup
        .status(|| autostart.is_enabled().map_err(|_| ()))
}

#[cfg(not(test))]
#[tauri::command]
fn set_autostart(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    enabled: bool,
) -> Result<AutostartStatus, String> {
    let autostart = app.autolaunch();
    state.startup.set(
        enabled,
        || {
            if enabled {
                autostart.enable()
            } else {
                autostart.disable()
            }
            .map_err(|_| ())
        },
        || autostart.is_enabled().map_err(|_| ()),
    )
}

#[cfg(not(test))]
#[tauri::command]
async fn sidecar_status(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.status())
        .await
        .map_err(|error| format!("status task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn check_session_readiness(
    state: State<'_, DesktopState>,
) -> Result<SessionReadiness, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.check_session_readiness())
        .await
        .map_err(|error| format!("session readiness task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn start_sidecar(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.start())
        .await
        .map_err(|error| format!("start task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn stop_sidecar(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.stop())
        .await
        .map_err(|error| format!("stop task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn open_login(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.open_login())
        .await
        .map_err(|error| format!("login task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn set_browser_bounds(
    window: tauri::WebviewWindow,
    state: State<'_, DesktopState>,
    bounds: BrowserBounds,
) -> Result<ServiceStatus, String> {
    let scale = window
        .scale_factor()
        .map_err(|e| format!("could not inspect window scale: {e}"))?;
    let size = window
        .inner_size()
        .map_err(|e| format!("could not inspect window size: {e}"))?;
    let physical = bounds.physical(scale, size.width, size.height)?;
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.resize_browser(physical))
        .await
        .map_err(|e| format!("resize task failed: {e}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn set_browser_visibility(
    state: State<'_, DesktopState>,
    visible: bool,
) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.set_browser_visibility(visible))
        .await
        .map_err(|e| format!("browser visibility task failed: {e}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn undock_browser(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.undock_browser())
        .await
        .map_err(|e| format!("undock task failed: {e}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn redock_browser(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.redock_browser())
        .await
        .map_err(|e| format!("dock task failed: {e}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn list_api_keys(state: State<'_, DesktopState>) -> Result<ApiKeyList, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.list_api_keys())
        .await
        .map_err(|error| format!("API-key list task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn create_api_key(
    state: State<'_, DesktopState>,
    label: String,
) -> Result<CreatedApiKey, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.create_api_key(&label))
        .await
        .map_err(|error| format!("API-key creation task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn revoke_api_key(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.revoke_api_key(&id))
        .await
        .map_err(|error| format!("API-key revocation task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn usage_status(state: State<'_, DesktopState>) -> Result<UsageSnapshot, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.usage())
        .await
        .map_err(|error| format!("usage task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn reset_usage(state: State<'_, DesktopState>) -> Result<(), String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.reset_usage())
        .await
        .map_err(|error| format!("usage reset task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn export_api_docs(app: tauri::AppHandle) -> Result<ExportedApiDocs, String> {
    let download_dir = app
        .path()
        .download_dir()
        .map_err(|_| "the Downloads directory is unavailable")?;
    tauri::async_runtime::spawn_blocking(move || admin::export_api_docs(&download_dir))
        .await
        .map_err(|error| format!("API documentation export task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn tunnel_status(state: State<'_, DesktopState>) -> Result<TunnelStatus, String> {
    let tunnel = Arc::clone(&state.tunnel);
    tauri::async_runtime::spawn_blocking(move || tunnel.status())
        .await
        .map_err(|error| format!("tunnel status task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn install_cloudflared(state: State<'_, DesktopState>) -> Result<TunnelStatus, String> {
    let tunnel = Arc::clone(&state.tunnel);
    tauri::async_runtime::spawn_blocking(move || tunnel.install_cloudflared())
        .await
        .map_err(|error| format!("cloudflared install task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn enable_access_tunnel(
    state: State<'_, DesktopState>,
    hostname: String,
) -> Result<TunnelStatus, String> {
    let tunnel = Arc::clone(&state.tunnel);
    tauri::async_runtime::spawn_blocking(move || tunnel.enable_access(&hostname))
        .await
        .map_err(|error| format!("tunnel activation task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn enable_bearer_tunnel(
    state: State<'_, DesktopState>,
    hostname: String,
    accepted: bool,
) -> Result<TunnelStatus, String> {
    let tunnel = Arc::clone(&state.tunnel);
    tauri::async_runtime::spawn_blocking(move || tunnel.enable_bearer_only(&hostname, accepted))
        .await
        .map_err(|error| format!("bearer-only activation task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn disable_tunnel(state: State<'_, DesktopState>) -> Result<TunnelStatus, String> {
    let tunnel = Arc::clone(&state.tunnel);
    tauri::async_runtime::spawn_blocking(move || tunnel.disable())
        .await
        .map_err(|error| format!("tunnel removal task failed: {error}"))?
}

#[cfg(not(test))]
#[tauri::command]
async fn open_tunnel_folder(state: State<'_, DesktopState>) -> Result<TunnelStatus, String> {
    let tunnel = Arc::clone(&state.tunnel);
    tauri::async_runtime::spawn_blocking(move || tunnel.open_setup_folder())
        .await
        .map_err(|error| format!("tunnel folder task failed: {error}"))?
}

#[cfg(not(test))]
pub fn run() {
    tauri::Builder::default()
        // Tauri requires single-instance to be registered before every other plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if show_main_window(app).is_err() {
                eprintln!("tab2api could not reveal its existing controller window");
            }
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(AUTOSTART_ENTRY_NAME)
                .arg(AUTOSTART_ARG)
                .build(),
        )
        .setup(|app| {
            let launched_from_autostart = startup::launched_from_autostart(std::env::args_os());
            if !launched_from_autostart {
                show_main_window(app.handle())?;
            }
            let resource_dir = app.path().resource_dir()?;
            let app_local_data_dir = app.path().app_local_data_dir()?;
            #[cfg(windows)]
            let parent_window = app
                .get_webview_window("main")
                .and_then(|window| window.hwnd().ok())
                .map(|hwnd| hwnd.0 as isize);
            #[cfg(not(windows))]
            let parent_window = None;
            let tunnel = TunnelManager::new(&resource_dir, &app_local_data_dir)
                .map_err(std::io::Error::other)?;
            let lifecycle = SidecarLifecycle::new(resource_dir, app_local_data_dir, parent_window)
                .map_err(std::io::Error::other)?;
            app.manage(DesktopState {
                lifecycle: Arc::new(lifecycle),
                startup: StartupManager::default(),
                tunnel: Arc::new(tunnel),
            });
            let show = MenuItem::with_id(app, "show", "Show tab2api", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let tray_icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| std::io::Error::other("the packaged application icon is missing"))?;
            TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("tab2api local bridge")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if show_main_window(app).is_err() {
                            eprintln!("tab2api could not reveal its controller window");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                        && show_main_window(tray.app_handle()).is_err()
                    {
                        eprintln!("tab2api could not reveal its controller window");
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            autostart_status,
            set_autostart,
            sidecar_status,
            check_session_readiness,
            start_sidecar,
            stop_sidecar,
            open_login,
            set_browser_bounds,
            set_browser_visibility,
            undock_browser,
            redock_browser,
            list_api_keys,
            create_api_key,
            revoke_api_key,
            usage_status,
            reset_usage,
            export_api_docs,
            tunnel_status,
            install_cloudflared,
            enable_access_tunnel,
            enable_bearer_tunnel,
            disable_tunnel,
            open_tunnel_folder
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tab2api desktop");
}

#[cfg(test)]
mod tests {
    #[test]
    fn frontend_native_bridge_is_enabled() {
        let config = include_str!("../tauri.conf.json");
        assert!(
            config.contains("\"withGlobalTauri\": true"),
            "ui/app.js requires Tauri's global invoke API"
        );

        let script = include_str!("../ui/app.js");
        assert!(script.contains("typeof invoke !== 'function'"));
        for command in [
            "autostart_status",
            "set_autostart",
            "check_session_readiness",
            "set_browser_visibility",
            "list_api_keys",
            "create_api_key",
            "revoke_api_key",
            "usage_status",
            "reset_usage",
            "export_api_docs",
            "tunnel_status",
            "install_cloudflared",
            "enable_access_tunnel",
            "enable_bearer_tunnel",
            "disable_tunnel",
            "open_tunnel_folder",
        ] {
            assert!(script.contains(command));
        }
        assert!(script.contains("bearerDialog.showModal"));
        assert!(!script.contains("window.confirm"));

        let capability = include_str!("../capabilities/default.json");
        assert!(!capability.contains("autostart:allow-"));

        let config: serde_json::Value =
            serde_json::from_str(config).expect("desktop config should be valid JSON");
        assert_eq!(
            config["productName"].as_str(),
            Some(crate::startup::AUTOSTART_ENTRY_NAME),
            "the NSIS product name must match the removable HKCU autostart value"
        );
        assert_eq!(config["app"]["windows"][0]["visible"], false);
    }
}
