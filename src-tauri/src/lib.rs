use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

pub mod asn;
pub mod db;
pub mod icmp;
pub mod monitor;
pub mod trace;

use asn::AsnCache;
use db::History;
use monitor::dns::{DnsCache, SystemResolver};
use monitor::{HostSpec, MonitorConfig, MonitorHandle};

/// Channel the frontend subscribes to for batched ping results.
pub const PING_TICK_EVENT: &str = "ping://tick";

/// How long a resolved hostname is trusted before re-resolving.
const DNS_TTL: Duration = Duration::from_secs(300);

struct AppState {
    monitor: Mutex<Option<MonitorHandle>>,
    /// `None` if the history database could not be opened. Monitoring still
    /// works without it — losing the graph would be a far worse failure than
    /// losing the log.
    history: Option<Arc<History>>,
    /// Why history is unavailable, if it is.
    history_error: Option<String>,
    /// Cancel flag for the trace in flight, if any. Only one runs at a time.
    trace_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Network names for hop addresses, kept for the life of the process.
    asn: Arc<AsnCache>,
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
    /// How many days of history to keep.
    retention_days: u32,
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

    let history = state.history.clone();
    if let Some(h) = &history {
        h.set_retention_days(args.retention_days);
        h.register(args.hosts.clone());
    }

    let emitter = app.clone();
    let handle = monitor::start(args.hosts, cfg, backend, dns, move |tick| {
        // Emit by reference so the tick can then be handed to the history
        // writer without a clone. Recording is a channel send, never a disk
        // write, so the scheduler is not slowed by it.
        let _ = emitter.emit(PING_TICK_EVENT, &tick);
        if let Some(h) = &history {
            h.record(tick);
        }
    });

    *state.monitor.lock().unwrap() = Some(handle);
    Ok(())
}

/// Settings live in `%APPDATA%\<identifier>\settings.json`, which is separate
/// from the install directory and so survives updates.
///
/// The payload is stored opaquely: the frontend owns the schema, so adding a
/// field there needs no matching change here.
/// Overrides where settings live. Set this when running the app for testing so
/// a throwaway run cannot touch the real configuration.
const DATA_DIR_ENV: &str = "BRETT_NET_DATA_DIR";

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = match std::env::var_os(DATA_DIR_ENV) {
        Some(v) => std::path::PathBuf::from(v),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Ping history goes in `%LOCALAPPDATA%`, not `%APPDATA%`. Roaming profiles and
/// FSLogix synchronise `%APPDATA%` at every logon, and a time series that grows
/// to hundreds of megabytes there would be a real problem on a managed machine.
fn history_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = match std::env::var_os(DATA_DIR_ENV) {
        Some(v) => std::path::PathBuf::from(v),
        None => app.path().app_local_data_dir().map_err(|e| e.to_string())?,
    };
    Ok(dir.join("history.db"))
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

/// Resolves the history store, or explains why there isn't one.
fn history(state: &tauri::State<'_, AppState>) -> Result<Arc<History>, String> {
    match (&state.history, &state.history_error) {
        (Some(h), _) => Ok(Arc::clone(h)),
        (None, Some(e)) => Err(format!("history is unavailable: {e}")),
        (None, None) => Err("history is unavailable".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    host_ids: Vec<String>,
    /// How far back to read, in seconds. 0 means the whole retention window.
    span_sec: u64,
    /// Cap on returned samples *per host*, matching the chart's capacity.
    per_host: u32,
}

/// Converts a lookback in seconds to an absolute cutoff. 0 means "everything".
fn cutoff_ms(span_sec: u64) -> i64 {
    if span_sec == 0 {
        0
    } else {
        db::now_ms() - (span_sec as i64) * 1000
    }
}

/// Runs blocking history work off the async runtime.
///
/// Every one of these commands waits on the writer thread and then touches the
/// disk. A synchronous Tauri command would run on the main thread and freeze the
/// window; awaiting directly would tie up an async worker for the duration of an
/// export, which can be millions of rows.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Samples from earlier sessions, so the chart is not blank after a restart.
#[tauri::command]
async fn history_since(
    state: tauri::State<'_, AppState>,
    query: HistoryQuery,
) -> Result<Vec<db::Sample>, String> {
    let h = history(&state)?;
    let since = cutoff_ms(query.span_sec);
    let limit = (query.per_host as usize).saturating_mul(query.host_ids.len().max(1));

    blocking(move || {
        // Without the barrier a read can legitimately miss a sample that was
        // recorded moments earlier but is still queued.
        h.flush()?;
        db::recent(h.path(), &query.host_ids, since, limit)
    })
    .await
}

#[tauri::command]
async fn history_stats(state: tauri::State<'_, AppState>) -> Result<db::Stats, String> {
    let h = history(&state)?;
    blocking(move || {
        h.flush()?;
        let mut s = db::stats(h.path())?;
        s.error = h.last_error();
        Ok(s)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    path: String,
    rows: u64,
}

/// Writes the history to a timestamped CSV in the user's Downloads folder.
///
/// A save-as dialog would need another plugin; a predictable location that
/// every Windows user already knows is a fair trade for now, and the full path
/// comes back so the UI can show exactly where it went.
#[tauri::command]
async fn export_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    span_sec: u64,
) -> Result<ExportResult, String> {
    let h = history(&state)?;
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|e| e.to_string())?;
    let dest = dir.join(format!(
        "brett-net-history-{}.csv",
        db::timestamp::local_file_stamp()
    ));
    let since = cutoff_ms(span_sec);

    blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let rows = db::export_csv(h.path(), &dest, since)?;
        Ok(ExportResult {
            path: dest.display().to_string(),
            rows,
        })
    })
    .await
}

/// Streamed to the frontend as a trace progresses.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TraceEvent {
    /// The target was resolved; sent before any probe.
    Resolved {
        target: String,
        addr: String,
    },
    Hop(trace::Hop),
    Done {
        outcome: trace::Outcome,
    },
}

/// Walks the path to a target, streaming each hop as it is found.
///
/// Results arrive over a channel rather than as a return value: a trace across
/// a filtered path takes minutes, and a view that shows nothing until it
/// finishes looks broken.
#[tauri::command]
async fn run_trace(
    state: tauri::State<'_, AppState>,
    target: String,
    config: trace::TraceConfig,
    on_event: tauri::ipc::Channel<TraceEvent>,
) -> Result<(), String> {
    // Replace any trace already running rather than interleaving two.
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(previous) = state
        .trace_cancel
        .lock()
        .unwrap()
        .replace(Arc::clone(&flag))
    {
        previous.store(true, Ordering::Relaxed);
    }

    blocking(move || {
        let dns = DnsCache::new(Arc::new(SystemResolver), DNS_TTL);
        let addr = dns
            .resolve(&target)
            .ok_or_else(|| format!("could not resolve {target}"))?;

        let _ = on_event.send(TraceEvent::Resolved {
            target,
            addr: addr.to_string(),
        });

        let backend = platform_backend();
        let outcome = trace::run(&backend, addr, &config, &flag, |hop| {
            let _ = on_event.send(TraceEvent::Hop(hop.clone()));
        });

        let _ = on_event.send(TraceEvent::Done { outcome });
        Ok(())
    })
    .await
}

#[tauri::command]
fn stop_trace(state: tauri::State<'_, AppState>) {
    if let Some(flag) = state.trace_cancel.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Names the networks behind a set of hop addresses.
///
/// Private, loopback and carrier-grade-NAT addresses are dropped before
/// anything leaves the machine, and a failed lookup returns nothing rather than
/// an error — a trace without network names is still a useful trace.
#[tauri::command]
async fn lookup_asn(
    state: tauri::State<'_, AppState>,
    ips: Vec<String>,
) -> Result<Vec<asn::AsnInfo>, String> {
    let cache = Arc::clone(&state.asn);
    let parsed: Vec<std::net::Ipv4Addr> = ips.iter().filter_map(|s| s.parse().ok()).collect();

    blocking(move || Ok(cache.resolve(&parsed))).await
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
        // Dormant on purpose. The endpoint 404s until a release publishes a
        // `latest.json`, at which point every already-installed copy starts
        // offering updates — the public key is baked in, so no reinstall.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // A history database that cannot be opened must not stop the app
            // from monitoring, so the failure is carried rather than returned.
            let (history, history_error) =
                match history_path(app.handle()).and_then(|p| History::open(p).map(Arc::new)) {
                    Ok(h) => (Some(h), None),
                    Err(e) => (None, Some(e)),
                };

            app.manage(AppState {
                monitor: Mutex::new(None),
                history,
                history_error,
                trace_cancel: Mutex::new(None),
                asn: Arc::new(AsnCache::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_info,
            start_monitor,
            stop_monitor,
            load_settings,
            save_settings,
            history_since,
            history_stats,
            export_history,
            run_trace,
            stop_trace,
            lookup_asn
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
