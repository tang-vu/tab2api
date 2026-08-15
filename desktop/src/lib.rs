mod browser_host;
mod lifecycle;
mod tunnel;

#[cfg(not(test))]
use browser_host::BrowserBounds;
#[cfg(not(test))]
use lifecycle::{ServiceStatus, SidecarLifecycle};
#[cfg(not(test))]
use std::sync::Arc;
#[cfg(not(test))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(test))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(not(test))]
use tauri::{Manager, State};
#[cfg(not(test))]
use tunnel::{TunnelManager, TunnelStatus};

#[cfg(not(test))]
struct DesktopState {
    lifecycle: Arc<SidecarLifecycle>,
    tunnel: Arc<TunnelManager>,
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
        .setup(|app| {
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
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
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
                        && let Some(window) = tray.app_handle().get_webview_window("main")
                    {
                        let _ = window.show();
                        let _ = window.set_focus();
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
            sidecar_status,
            start_sidecar,
            stop_sidecar,
            open_login,
            set_browser_bounds,
            undock_browser,
            redock_browser,
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
    }
}
