mod lifecycle;

use lifecycle::{ServiceStatus, SidecarLifecycle};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State};

struct DesktopState {
    lifecycle: Arc<SidecarLifecycle>,
}

#[tauri::command]
async fn sidecar_status(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.status())
        .await
        .map_err(|error| format!("status task failed: {error}"))?
}

#[tauri::command]
async fn start_sidecar(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.start())
        .await
        .map_err(|error| format!("start task failed: {error}"))?
}

#[tauri::command]
async fn stop_sidecar(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.stop())
        .await
        .map_err(|error| format!("stop task failed: {error}"))?
}

#[tauri::command]
async fn open_login(state: State<'_, DesktopState>) -> Result<ServiceStatus, String> {
    let lifecycle = Arc::clone(&state.lifecycle);
    tauri::async_runtime::spawn_blocking(move || lifecycle.open_login())
        .await
        .map_err(|error| format!("login task failed: {error}"))?
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let app_local_data_dir = app.path().app_local_data_dir()?;
            let lifecycle = SidecarLifecycle::new(resource_dir, app_local_data_dir)
                .map_err(std::io::Error::other)?;
            app.manage(DesktopState {
                lifecycle: Arc::new(lifecycle),
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
            open_login
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tab2api desktop");
}
