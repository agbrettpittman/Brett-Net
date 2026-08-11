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
            stop_monitor
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
