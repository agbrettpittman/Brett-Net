//! Ping history: an append-only sample log in SQLite.
//!
//! Writes go through a dedicated thread so the scheduler never blocks on disk,
//! and each batch commits in one transaction. Reads open their own read-only
//! connection — WAL makes that safe alongside the writer — after waiting on a
//! [`History::flush`] barrier so they cannot miss a sample that was already
//! queued.
//!
//! The database lives under `%LOCALAPPDATA%`, deliberately *not* `%APPDATA%`:
//! roaming profiles synchronise the latter on every logon, and a multi-hundred
//! megabyte time series there would be a genuine problem on a managed machine.

pub mod timestamp;

use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;

use crate::icmp::PingStatus;
use crate::monitor::{HostSpec, PingTick};

/// How long samples are kept by default.
pub const DEFAULT_RETENTION_DAYS: u32 = 7;
pub const MIN_RETENTION_DAYS: u32 = 1;
pub const MAX_RETENTION_DAYS: u32 = 90;

/// Hard ceiling on the database, enforced regardless of the retention window.
/// Roughly a fortnight of ten hosts at one probe per second.
const MAX_BYTES: i64 = 256 * 1024 * 1024;

/// How often the writer thread considers pruning. Deleting rows is cheap but
/// not free, and there is no reason to do it on every tick.
const PRUNE_EVERY: Duration = Duration::from_secs(300);

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One stored sample, as read back for chart back-fill.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// Unix epoch milliseconds.
    pub t: i64,
    pub host_id: String,
    pub rtt_us: Option<u32>,
    pub status: PingStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub samples: i64,
    pub bytes: i64,
    pub oldest_ms: Option<i64>,
    pub newest_ms: Option<i64>,
    pub path: String,
    /// Set when a background write or prune failed. Surfaced rather than logged
    /// so a silently broken history is visible in the UI.
    pub error: Option<String>,
}

enum Msg {
    Tick(PingTick),
    Hosts(Vec<HostSpec>),
    Retention(u32),
    /// Answered once every message queued before it has committed.
    Sync(SyncSender<()>),
}

pub struct History {
    tx: Sender<Msg>,
    path: PathBuf,
    error: Arc<Mutex<Option<String>>>,
}

impl History {
    /// Opens (creating if needed) the history database and starts its writer.
    ///
    /// The schema is applied on the calling thread so a corrupt or unwritable
    /// file fails loudly at startup rather than silently on a background thread.
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let conn = Connection::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        init(&conn).map_err(|e| format!("{}: {e}", path.display()))?;

        let (tx, rx) = mpsc::channel();
        let error = Arc::new(Mutex::new(None));
        let thread_error = Arc::clone(&error);

        thread::Builder::new()
            .name("brett-net-history".into())
            .spawn(move || writer(conn, rx, thread_error))
            .map_err(|e| format!("could not start the history writer: {e}"))?;

        Ok(Self { tx, path, error })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Records the hosts being monitored, so exports carry labels and targets
    /// rather than bare ids.
    pub fn register(&self, hosts: Vec<HostSpec>) {
        let _ = self.tx.send(Msg::Hosts(hosts));
    }

    pub fn record(&self, tick: PingTick) {
        let _ = self.tx.send(Msg::Tick(tick));
    }

    pub fn set_retention_days(&self, days: u32) {
        let _ = self.tx.send(Msg::Retention(days));
    }

    /// Blocks until everything queued so far has been committed.
    ///
    /// Reads must call this first: the writer is asynchronous, so without a
    /// barrier a query can legitimately miss samples the caller just recorded.
    pub fn flush(&self) -> Result<(), String> {
        let (ack, done) = mpsc::sync_channel(0);
        self.tx
            .send(Msg::Sync(ack))
            .map_err(|_| "the history writer has stopped".to_string())?;
        done.recv()
            .map_err(|_| "the history writer has stopped".to_string())
    }

    pub fn last_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }
}

fn init(conn: &Connection) -> rusqlite::Result<()> {
    // auto_vacuum only takes effect if it is set before any table exists, so it
    // must come first. Existing databases keep whatever they were created with.
    conn.execute_batch(
        "PRAGMA auto_vacuum = INCREMENTAL;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;

         CREATE TABLE IF NOT EXISTS hosts (
           key    INTEGER PRIMARY KEY,
           id     TEXT NOT NULL UNIQUE,
           label  TEXT NOT NULL,
           target TEXT NOT NULL
         );

         CREATE TABLE IF NOT EXISTS samples (
           t      INTEGER NOT NULL,
           host   INTEGER NOT NULL REFERENCES hosts(key),
           rtt_us INTEGER,
           status INTEGER NOT NULL
         );

         CREATE INDEX IF NOT EXISTS samples_t ON samples(t);",
    )
}

fn writer(mut conn: Connection, rx: Receiver<Msg>, error: Arc<Mutex<Option<String>>>) {
    let mut keys: HashMap<String, i64> = HashMap::new();
    let mut retention = DEFAULT_RETENTION_DAYS;
    let mut last_prune = Instant::now();
    // Nothing is pruned until the retention window has been set. Trimming at
    // startup on the default would quietly delete history that the user had
    // configured a longer window for, since the setting arrives from the
    // frontend a moment after the database opens.
    let mut prune_due = false;

    let report = |err: Option<String>| {
        if let Ok(mut slot) = error.lock() {
            *slot = err;
        }
    };

    // `recv` blocks until there is work; `try_iter` then sweeps up anything that
    // piled up behind it, so a burst commits as one transaction.
    while let Ok(first) = rx.recv() {
        let mut ticks = Vec::new();
        let mut hosts = Vec::new();
        let mut barriers = Vec::new();

        for msg in std::iter::once(first).chain(rx.try_iter()) {
            match msg {
                Msg::Tick(t) => ticks.push(t),
                Msg::Hosts(h) => hosts.extend(h),
                Msg::Retention(d) => {
                    retention = d.clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
                    prune_due = true;
                }
                Msg::Sync(ack) => barriers.push(ack),
            }
        }

        let mut failure = write_batch(&mut conn, &hosts, &ticks, &mut keys)
            .err()
            .map(|e| format!("write failed: {e}"));

        if prune_due || last_prune.elapsed() >= PRUNE_EVERY {
            prune_due = false;
            last_prune = Instant::now();
            if let Err(e) = prune(&conn, retention, now_ms()) {
                failure.get_or_insert(format!("prune failed: {e}"));
            }
        }

        report(failure);

        // Answered only after the batch has committed, which is the whole
        // point of the barrier.
        for ack in barriers {
            let _ = ack.send(());
        }
    }
}

fn write_batch(
    conn: &mut Connection,
    hosts: &[HostSpec],
    ticks: &[PingTick],
    keys: &mut HashMap<String, i64>,
) -> rusqlite::Result<()> {
    if hosts.is_empty() && ticks.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    for h in hosts {
        let key = upsert_host(&tx, &h.id, &h.label, &h.target)?;
        keys.insert(h.id.clone(), key);
    }

    {
        let mut stmt =
            tx.prepare_cached("INSERT INTO samples (t, host, rtt_us, status) VALUES (?, ?, ?, ?)")?;
        for tick in ticks {
            for r in &tick.results {
                let key = match keys.get(&r.host_id) {
                    Some(k) => *k,
                    None => {
                        // A result for a host we were never told about. Record
                        // it under its id so the sample is not simply dropped.
                        let k = upsert_host(&tx, &r.host_id, &r.host_id, "")?;
                        keys.insert(r.host_id.clone(), k);
                        k
                    }
                };
                stmt.execute(params![tick.t, key, r.rtt_us, r.status.code()])?;
            }
        }
    }

    tx.commit()
}

fn upsert_host(conn: &Connection, id: &str, label: &str, target: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO hosts (id, label, target) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, target = excluded.target
         RETURNING key",
        params![id, label, target],
        |r| r.get(0),
    )
}

fn db_bytes(conn: &Connection) -> rusqlite::Result<i64> {
    let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    let size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    Ok(pages * size)
}

/// Enforces the retention window, then the size cap.
///
/// Returns the number of rows deleted, which the tests assert on.
fn prune(conn: &Connection, retention_days: u32, now: i64) -> rusqlite::Result<usize> {
    let cutoff = now - i64::from(retention_days) * DAY_MS;
    let mut removed = conn.execute("DELETE FROM samples WHERE t < ?", [cutoff])?;

    // The size cap is a backstop for a retention window that is too generous
    // for the number of hosts being watched. Drop an hour at a time from the
    // oldest end, reclaiming pages as we go — until deleted pages are returned
    // to the file, the size never appears to change.
    loop {
        conn.execute_batch("PRAGMA incremental_vacuum;")?;
        if db_bytes(conn)? <= MAX_BYTES {
            break;
        }
        let oldest: Option<i64> = conn.query_row("SELECT MIN(t) FROM samples", [], |r| r.get(0))?;
        let Some(oldest) = oldest else { break };
        removed += conn.execute("DELETE FROM samples WHERE t < ?", [oldest + HOUR_MS])?;
    }

    Ok(removed)
}

fn open_read(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// The most recent samples for the given hosts, oldest first.
///
/// `limit` bounds rows rather than timestamps, so callers scale it by host
/// count. Nothing is returned for hosts not named, which keeps history for a
/// since-deleted host out of the chart.
pub fn recent(
    path: &Path,
    host_ids: &[String],
    since_ms: i64,
    limit: usize,
) -> Result<Vec<Sample>, String> {
    if host_ids.is_empty() || !path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_read(path)?;

    let placeholders = vec!["?"; host_ids.len()].join(",");
    let sql = format!(
        "SELECT s.t, h.id, s.rtt_us, s.status
           FROM samples s JOIN hosts h ON h.key = s.host
          WHERE s.t >= ? AND h.id IN ({placeholders})
          ORDER BY s.t DESC
          LIMIT ?"
    );

    let limit = limit as i64;
    let mut binds: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(host_ids.len() + 2);
    binds.push(&since_ms);
    for id in host_ids {
        binds.push(id);
    }
    binds.push(&limit);

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(binds.as_slice(), |r| {
            Ok(Sample {
                t: r.get(0)?,
                host_id: r.get(1)?,
                rtt_us: r.get(2)?,
                status: PingStatus::from_code(r.get::<_, u8>(3)?),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    // The query takes the newest rows; the chart wants them in time order.
    out.reverse();
    Ok(out)
}

pub fn stats(path: &Path) -> Result<Stats, String> {
    let mut out = Stats {
        samples: 0,
        bytes: 0,
        oldest_ms: None,
        newest_ms: None,
        path: path.display().to_string(),
        error: None,
    };
    if !path.exists() {
        return Ok(out);
    }

    let conn = open_read(path)?;
    let (samples, oldest, newest): (i64, Option<i64>, Option<i64>) = conn
        .query_row("SELECT COUNT(*), MIN(t), MAX(t) FROM samples", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?;

    out.samples = samples;
    out.oldest_ms = oldest;
    out.newest_ms = newest;
    out.bytes = db_bytes(&conn).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Writes samples since `since_ms` to `dest` as CSV. Returns the row count.
///
/// Rows are streamed rather than collected: a week of history can be millions
/// of rows, and materialising them would spike memory for no benefit.
pub fn export_csv(path: &Path, dest: &Path, since_ms: i64) -> Result<u64, String> {
    let file = std::fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut out = BufWriter::new(file);
    writeln!(out, "timestamp_utc,epoch_ms,host,target,rtt_ms,status").map_err(|e| e.to_string())?;

    if !path.exists() {
        out.flush().map_err(|e| e.to_string())?;
        return Ok(0);
    }

    let conn = open_read(path)?;
    let mut stmt = conn
        .prepare(
            "SELECT s.t, h.label, h.target, s.rtt_us, s.status
               FROM samples s JOIN hosts h ON h.key = s.host
              WHERE s.t >= ?
              ORDER BY s.t ASC",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query([since_ms]).map_err(|e| e.to_string())?;
    let mut count = 0u64;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let t: i64 = row.get(0).map_err(|e| e.to_string())?;
        let label: String = row.get(1).map_err(|e| e.to_string())?;
        let target: String = row.get(2).map_err(|e| e.to_string())?;
        let rtt_us: Option<u32> = row.get(3).map_err(|e| e.to_string())?;
        let status = PingStatus::from_code(row.get::<_, u8>(4).map_err(|e| e.to_string())?);

        // Milliseconds with microsecond precision — the raw unit is integer
        // microseconds, so this is lossless.
        let rtt = rtt_us.map_or(String::new(), |us| format!("{:.3}", f64::from(us) / 1000.0));
        writeln!(
            out,
            "{},{},{},{},{},{}",
            timestamp::iso_utc(t),
            t,
            csv_field(&label),
            csv_field(&target),
            rtt,
            status.as_str()
        )
        .map_err(|e| e.to_string())?;
        count += 1;
    }

    out.flush().map_err(|e| e.to_string())?;
    Ok(count)
}

/// Quotes a field if it contains anything that would break the row apart.
/// Host labels are user-typed, so commas and quotes are entirely plausible.
fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::PingResult;

    struct TempDb {
        dir: PathBuf,
    }

    impl TempDb {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "brett-net-db-{name}-{}-{:?}",
                std::process::id(),
                thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn path(&self) -> PathBuf {
            self.dir.join("history.db")
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn host(id: &str) -> HostSpec {
        HostSpec {
            id: id.into(),
            label: format!("Host {id}"),
            target: format!("10.0.0.{}", id.len()),
            probe: Default::default(),
        }
    }

    fn tick(t: i64, host_id: &str, rtt_us: Option<u32>, status: PingStatus) -> PingTick {
        PingTick {
            seq: 0,
            t,
            results: vec![PingResult {
                host_id: host_id.into(),
                rtt_us,
                status,
                from: None,
            }],
        }
    }

    #[test]
    fn records_and_reads_back_samples() {
        let tmp = TempDb::new("roundtrip");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);
        h.record(tick(1000, "a", Some(12_345), PingStatus::Success));
        h.record(tick(2000, "a", None, PingStatus::TimedOut));
        h.flush().unwrap();
        assert_eq!(h.last_error(), None);

        let got = recent(tmp.path().as_path(), &["a".into()], 0, 100).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].t, 1000, "samples must come back oldest first");
        assert_eq!(got[0].rtt_us, Some(12_345));
        assert_eq!(got[0].status, PingStatus::Success);
        assert_eq!(got[1].rtt_us, None);
        assert_eq!(got[1].status, PingStatus::TimedOut);
    }

    #[test]
    fn reads_only_the_hosts_asked_for() {
        let tmp = TempDb::new("filter");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a"), host("b")]);
        h.record(tick(1000, "a", Some(1000), PingStatus::Success));
        h.record(tick(1000, "b", Some(2000), PingStatus::Success));
        h.flush().unwrap();

        // A host the user has since deleted must not reappear on the chart.
        let got = recent(tmp.path().as_path(), &["b".into()], 0, 100).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].host_id, "b");
    }

    #[test]
    fn limit_keeps_the_newest_samples() {
        let tmp = TempDb::new("limit");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);
        for t in 1..=10 {
            h.record(tick(t * 1000, "a", Some(1000), PingStatus::Success));
        }
        h.flush().unwrap();

        let got = recent(tmp.path().as_path(), &["a".into()], 0, 3).unwrap();
        let ts: Vec<i64> = got.iter().map(|s| s.t).collect();
        assert_eq!(ts, vec![8000, 9000, 10_000]);
    }

    #[test]
    fn since_excludes_older_samples() {
        let tmp = TempDb::new("since");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);
        for t in 1..=5 {
            h.record(tick(t * 1000, "a", Some(1000), PingStatus::Success));
        }
        h.flush().unwrap();

        let got = recent(tmp.path().as_path(), &["a".into()], 3000, 100).unwrap();
        assert_eq!(
            got.iter().map(|s| s.t).collect::<Vec<_>>(),
            vec![3000, 4000, 5000]
        );
    }

    #[test]
    fn a_result_for_an_unregistered_host_is_still_stored() {
        let tmp = TempDb::new("unregistered");
        let h = History::open(tmp.path()).unwrap();
        // No register() call at all.
        h.record(tick(1000, "ghost", Some(500), PingStatus::Success));
        h.flush().unwrap();
        assert_eq!(h.last_error(), None);

        let got = recent(tmp.path().as_path(), &["ghost".into()], 0, 10).unwrap();
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn renaming_a_host_updates_its_row_rather_than_duplicating_it() {
        let tmp = TempDb::new("rename");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);
        h.record(tick(1000, "a", Some(500), PingStatus::Success));
        h.register(vec![HostSpec {
            label: "Renamed".into(),
            target: "1.1.1.1".into(),
            ..host("a")
        }]);
        h.record(tick(2000, "a", Some(500), PingStatus::Success));
        h.flush().unwrap();

        let conn = open_read(tmp.path().as_path()).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM hosts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "a rename must not create a second host row");

        // Both samples keep pointing at the one row, so history is not orphaned.
        assert_eq!(
            recent(tmp.path().as_path(), &["a".into()], 0, 10)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn prune_drops_samples_past_the_retention_window() {
        let tmp = TempDb::new("prune");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);

        let now = 30 * DAY_MS;
        h.record(tick(now - 10 * DAY_MS, "a", Some(500), PingStatus::Success));
        h.record(tick(now - 2 * DAY_MS, "a", Some(500), PingStatus::Success));
        h.record(tick(now, "a", Some(500), PingStatus::Success));
        h.flush().unwrap();

        let conn = Connection::open(tmp.path()).unwrap();
        let removed = prune(&conn, 7, now).unwrap();
        assert_eq!(
            removed, 1,
            "only the ten-day-old sample is past a 7 day window"
        );

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM samples", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 2);
    }

    #[test]
    fn setting_retention_prunes_what_is_already_stored() {
        // The writer only prunes once it has been told the window, so this is
        // also the guard against it trimming on the default before the frontend
        // has said how long the user wants to keep.
        let tmp = TempDb::new("retention-msg");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);

        let now = now_ms();
        h.record(tick(now - 9 * DAY_MS, "a", Some(500), PingStatus::Success));
        h.record(tick(now - HOUR_MS, "a", Some(500), PingStatus::Success));
        h.flush().unwrap();
        assert_eq!(
            recent(tmp.path().as_path(), &["a".into()], 0, 10)
                .unwrap()
                .len(),
            2,
            "nothing should be pruned before a retention window is set"
        );

        h.set_retention_days(7);
        h.flush().unwrap();
        assert_eq!(h.last_error(), None);

        let left = recent(tmp.path().as_path(), &["a".into()], 0, 10).unwrap();
        assert_eq!(left.len(), 1, "the nine-day-old sample should be gone");
        assert_eq!(left[0].t, now - HOUR_MS);
    }

    #[test]
    fn retention_is_clamped_to_a_sane_range() {
        let tmp = TempDb::new("retention-clamp");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);

        let now = now_ms();
        h.record(tick(now - 2 * HOUR_MS, "a", Some(500), PingStatus::Success));
        // Zero would otherwise mean "keep nothing", wiping history on a typo.
        h.set_retention_days(0);
        h.flush().unwrap();

        assert_eq!(
            recent(tmp.path().as_path(), &["a".into()], 0, 10)
                .unwrap()
                .len(),
            1,
            "a two-hour-old sample survives the one-day minimum"
        );
    }

    #[test]
    fn prune_terminates_when_there_is_nothing_left_to_drop() {
        // The size-cap loop deletes from the oldest end; with an empty table it
        // must exit rather than spin.
        let tmp = TempDb::new("prune-empty");
        let conn = Connection::open(tmp.path()).unwrap();
        init(&conn).unwrap();
        assert_eq!(prune(&conn, 7, now_ms()).unwrap(), 0);
    }

    #[test]
    fn stats_report_what_is_stored() {
        let tmp = TempDb::new("stats");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![host("a")]);
        h.record(tick(1000, "a", Some(500), PingStatus::Success));
        h.record(tick(5000, "a", Some(500), PingStatus::Success));
        h.flush().unwrap();

        let s = stats(tmp.path().as_path()).unwrap();
        assert_eq!(s.samples, 2);
        assert_eq!(s.oldest_ms, Some(1000));
        assert_eq!(s.newest_ms, Some(5000));
        assert!(s.bytes > 0);
        assert_eq!(s.error, None);
    }

    #[test]
    fn stats_on_a_missing_database_are_empty_rather_than_an_error() {
        let tmp = TempDb::new("stats-missing");
        let s = stats(tmp.path().as_path()).unwrap();
        assert_eq!(s.samples, 0);
        assert_eq!(s.oldest_ms, None);
    }

    #[test]
    fn exports_csv_with_a_header_and_one_row_per_sample() {
        let tmp = TempDb::new("csv");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![HostSpec {
            label: "Gateway".into(),
            target: "192.168.1.1".into(),
            ..host("a")
        }]);
        h.record(tick(
            1_786_545_125_123,
            "a",
            Some(12_345),
            PingStatus::Success,
        ));
        h.record(tick(1_786_545_126_123, "a", None, PingStatus::TimedOut));
        h.flush().unwrap();

        let dest = tmp.dir.join("out.csv");
        let n = export_csv(tmp.path().as_path(), &dest, 0).unwrap();
        assert_eq!(n, 2);

        let body = std::fs::read_to_string(&dest).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines[0], "timestamp_utc,epoch_ms,host,target,rtt_ms,status");
        assert_eq!(
            lines[1],
            "2026-08-12T14:32:05.123Z,1786545125123,Gateway,192.168.1.1,12.345,success"
        );
        // A timeout has no round trip, so the column is empty rather than zero —
        // zero would average in as a real measurement.
        assert_eq!(
            lines[2],
            "2026-08-12T14:32:06.123Z,1786545126123,Gateway,192.168.1.1,,timedOut"
        );
    }

    #[test]
    fn exports_quote_labels_containing_commas() {
        let tmp = TempDb::new("csv-quote");
        let h = History::open(tmp.path()).unwrap();
        h.register(vec![HostSpec {
            label: "Site A, floor 2".into(),
            target: "10.0.0.1".into(),
            ..host("a")
        }]);
        h.record(tick(0, "a", Some(1000), PingStatus::Success));
        h.flush().unwrap();

        let dest = tmp.dir.join("out.csv");
        export_csv(tmp.path().as_path(), &dest, 0).unwrap();
        let body = std::fs::read_to_string(&dest).unwrap();
        assert!(
            body.contains("\"Site A, floor 2\""),
            "label with a comma must be quoted, got: {body}"
        );
    }

    #[test]
    fn csv_field_escapes_embedded_quotes() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn export_of_an_empty_history_still_writes_a_header() {
        let tmp = TempDb::new("csv-empty");
        let dest = tmp.dir.join("out.csv");
        assert_eq!(export_csv(tmp.path().as_path(), &dest, 0).unwrap(), 0);
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap().trim(),
            "timestamp_utc,epoch_ms,host,target,rtt_ms,status"
        );
    }

    #[test]
    fn history_survives_reopening_the_same_file() {
        let tmp = TempDb::new("reopen");
        {
            let h = History::open(tmp.path()).unwrap();
            h.register(vec![host("a")]);
            h.record(tick(1000, "a", Some(500), PingStatus::Success));
            h.flush().unwrap();
        }
        let h = History::open(tmp.path()).unwrap();
        h.record(tick(2000, "a", Some(500), PingStatus::Success));
        h.flush().unwrap();

        assert_eq!(
            recent(tmp.path().as_path(), &["a".into()], 0, 10)
                .unwrap()
                .len(),
            2,
            "samples from an earlier session must still be there"
        );
    }
}
