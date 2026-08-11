use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

pub mod icmp;
pub mod monitor;

use monitor::dns::{DnsCache, SystemResolver};
use monitor::{HostSpec, MonitorConfig, MonitorHandle};

/// Channel the frontend subscribes to for batched ping results.
pub const PING_TICK_EVENT: &str = "ping://tick";

/// How long a resolved hostname is trusted before re-resolving.
const DNS_TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
struct AppState {
    monitor: Mutex<Option<MonitorHandle>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    app_version: String,
    hostname: String,
    os: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    hosts: Vec<HostSpec>,
    /// Milliseconds between probes of the same host.
    interval_ms: u64,
    /// Milliseconds to wait for a reply.
    timeout_ms: u64,
}

#[tauri::command]
fn host_info(app: tauri::AppHandle) -> HostInfo {
    HostInfo {
        app_version: app.package_info().version.to_string(),
        hostname: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "unknown".into()),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

#[tauri::command]
async fn start_monitor(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    args: StartArgs,
) -> Result<(), String> {
    if args.hosts.is_empty() {
        return Err("no hosts to monitor".into());
    }

    // Replace any existing run rather than stacking schedulers.
    if let Some(existing) = state.monitor.lock().unwrap().take() {
        existing.stop();
    }

    let cfg = MonitorConfig {
        interval: Duration::from_millis(args.interval_ms.max(100)),
        timeout: Duration::from_millis(args.timeout_ms.max(100)),
        ttl: monitor::DEFAULT_TTL,
    };

    let backend = Arc::new(platform_backend());
    let dns = Arc::new(DnsCache::new(Arc::new(SystemResolver), DNS_TTL));

    let emitter = app.clone();
    let handle = monitor::start(args.hosts, cfg, backend, dns, move |tick| {
        let _ = emitter.emit(PING_TICK_EVENT, tick);
    });

    *state.monitor.lock().unwrap() = Some(handle);
    Ok(())
}

/// Settings live in `%APPDATA%\<identifier>\settings.json`, which is separate
/// from the install directory and so survives updates.
///
/// The payload is stored opaquely: the frontend owns the schema, so adding a
/// field there needs no matching change here.
fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Notepad and PowerShell's `-Encoding utf8` both prepend a UTF-8 BOM, which
    // serde_json rejects. Tolerate it so a hand-edited file still loads.
    let trimmed = raw.trim_start_matches('\u{feff}');

    match serde_json::from_str(trimmed) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            // Do not fall back silently: the app would start on defaults and the
            // next autosave would overwrite whatever the user had. Preserve it.
            let backup = path.with_extension("json.bad");
            let _ = std::fs::rename(&path, &backup);
            Err(format!(
                "settings.json could not be parsed ({e}). It was kept as \
                 settings.json.bad and defaults were loaded."
            ))
        }
    }
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;

    // Write-then-rename, so a crash mid-write cannot truncate the real file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_monitor(state: tauri::State<'_, AppState>) {
    if let Some(existing) = state.monitor.lock().unwrap().take() {
        existing.stop();
    }
}

#[cfg(windows)]
fn platform_backend() -> icmp::windows::WindowsIcmp {
    icmp::windows::WindowsIcmp
}

/// Non-Windows builds exist only so the crate still compiles for tooling; the
/// app targets Windows, where the real ICMP backend lives.
#[cfg(not(windows))]
fn platform_backend() -> icmp::mock::MockBackend {
    icmp::mock::MockBackend::new(1000)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(AppState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_info,
            start_monitor,
            stop_monitor,
            load_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
