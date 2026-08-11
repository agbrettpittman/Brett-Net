//! Ping scheduling: one task per host, results batched into per-tick events.

pub mod dns;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::icmp::{EchoOutcome, PingBackend, PingStatus};
use dns::DnsCache;

/// Default TTL for a normal ping — high enough to cross any real path.
pub const DEFAULT_TTL: u8 = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSpec {
    pub id: String,
    pub label: String,
    /// Hostname or IPv4 literal.
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub host_id: String,
    pub rtt_us: Option<u32>,
    pub status: PingStatus,
    pub from: Option<String>,
}

/// One batch of results. Emitting per tick rather than per ping keeps the event
/// rate at 1/s instead of 50/s for 50 hosts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingTick {
    pub seq: u64,
    /// Unix epoch milliseconds.
    pub t: i64,
    pub results: Vec<PingResult>,
}

#[derive(Debug, Clone)]
pub struct MonitorConfig {
    pub interval: Duration,
    pub timeout: Duration,
    pub ttl: u8,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(1),
            timeout: Duration::from_secs(2),
            ttl: DEFAULT_TTL,
        }
    }
}

pub struct MonitorHandle {
    tasks: Vec<JoinHandle<()>>,
}

impl MonitorHandle {
    pub fn stop(self) {
        for t in self.tasks {
            t.abort();
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Evenly spreads each host's send across the interval.
///
/// Firing every host simultaneously makes remote ICMP rate limiters drop
/// replies, which shows up as phantom packet loss. Spreading them keeps each
/// target seeing a steady one-per-interval trickle.
fn stagger(index: usize, count: usize, interval: Duration) -> Duration {
    if count <= 1 {
        return Duration::ZERO;
    }
    interval.mul_f64(index as f64 / count as f64)
}

/// Starts monitoring. `emit` is called once per tick with the batched results.
pub fn start<E>(
    hosts: Vec<HostSpec>,
    cfg: MonitorConfig,
    backend: Arc<dyn PingBackend>,
    dns: Arc<DnsCache>,
    emit: E,
) -> MonitorHandle
where
    E: Fn(PingTick) + Send + Sync + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<PingResult>();
    let count = hosts.len();
    let mut tasks = Vec::with_capacity(count + 1);

    for (i, host) in hosts.into_iter().enumerate() {
        let tx = tx.clone();
        let backend = Arc::clone(&backend);
        let dns = Arc::clone(&dns);
        let cfg = cfg.clone();
        let offset = stagger(i, count, cfg.interval);

        tasks.push(tokio::spawn(async move {
            tokio::time::sleep(offset).await;
            let mut ticker = tokio::time::interval(cfg.interval);
            // If a probe overruns the interval, skip ahead rather than
            // queueing up a burst of catch-up sends.
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                ticker.tick().await;
                let backend = Arc::clone(&backend);
                let dns = Arc::clone(&dns);
                let target = host.target.clone();
                let (timeout, ttl) = (cfg.timeout, cfg.ttl);

                // The Win32 echo blocks, so it runs on the blocking pool.
                let outcome = tokio::task::spawn_blocking(move || match dns.resolve(&target) {
                    Some(ip) => backend.echo(ip, ttl, timeout),
                    None => EchoOutcome::dns_failure(),
                })
                .await;

                let Ok(outcome) = outcome else { continue };
                let sent = tx.send(PingResult {
                    host_id: host.id.clone(),
                    rtt_us: outcome.rtt_us,
                    status: outcome.status,
                    from: outcome.from.map(|a| a.to_string()),
                });
                if sent.is_err() {
                    break; // aggregator is gone
                }
            }
        }));
    }
    drop(tx);

    let interval = cfg.interval;
    tasks.push(tokio::spawn(async move {
        let seq = AtomicU64::new(0);
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut buf: Vec<PingResult> = Vec::new();

        loop {
            tokio::select! {
                recv = rx.recv() => match recv {
                    Some(r) => buf.push(r),
                    None => break,
                },
                _ = ticker.tick() => {
                    if !buf.is_empty() {
                        emit(PingTick {
                            seq: seq.fetch_add(1, Ordering::SeqCst),
                            t: now_ms(),
                            results: std::mem::take(&mut buf),
                        });
                    }
                }
            }
        }
    }));

    MonitorHandle { tasks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icmp::mock::MockBackend;
    use dns::{Resolver, SystemResolver};
    use std::net::Ipv4Addr;
    use std::sync::Mutex;

    struct Loopback;
    impl Resolver for Loopback {
        fn resolve(&self, _host: &str) -> Option<Ipv4Addr> {
            Some(Ipv4Addr::LOCALHOST)
        }
    }

    fn hosts(n: usize) -> Vec<HostSpec> {
        (0..n)
            .map(|i| HostSpec {
                id: format!("h{i}"),
                label: format!("Host {i}"),
                target: format!("10.0.0.{}", i + 1),
            })
            .collect()
    }

    #[test]
    fn stagger_spreads_hosts_across_the_interval() {
        let iv = Duration::from_millis(1000);
        assert_eq!(stagger(0, 4, iv), Duration::from_millis(0));
        assert_eq!(stagger(1, 4, iv), Duration::from_millis(250));
        assert_eq!(stagger(2, 4, iv), Duration::from_millis(500));
        assert_eq!(stagger(3, 4, iv), Duration::from_millis(750));
    }

    #[test]
    fn stagger_is_zero_for_a_single_host() {
        assert_eq!(stagger(0, 1, Duration::from_secs(1)), Duration::ZERO);
        assert_eq!(stagger(0, 0, Duration::from_secs(1)), Duration::ZERO);
    }

    #[tokio::test]
    async fn emits_batched_ticks_covering_every_host() {
        let collected: Arc<Mutex<Vec<PingTick>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&collected);

        let handle = start(
            hosts(3),
            MonitorConfig {
                interval: Duration::from_millis(60),
                timeout: Duration::from_millis(200),
                ttl: DEFAULT_TTL,
            },
            Arc::new(MockBackend::new(1500)),
            Arc::new(DnsCache::new(Arc::new(Loopback), Duration::from_secs(60))),
            move |tick| sink.lock().unwrap().push(tick),
        );

        tokio::time::sleep(Duration::from_millis(400)).await;
        handle.stop();

        let ticks = collected.lock().unwrap();
        assert!(!ticks.is_empty(), "expected at least one tick");

        let seen: std::collections::HashSet<_> = ticks
            .iter()
            .flat_map(|t| t.results.iter().map(|r| r.host_id.clone()))
            .collect();
        assert_eq!(seen.len(), 3, "every host should report, saw {seen:?}");

        assert!(ticks.iter().all(|t| t.t > 0), "ticks need a timestamp");
        let seqs: Vec<_> = ticks.iter().map(|t| t.seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted, "sequence numbers must increase monotonically");
    }

    #[tokio::test]
    async fn unresolvable_hosts_report_dns_failure_rather_than_stalling() {
        struct NoDns;
        impl Resolver for NoDns {
            fn resolve(&self, _host: &str) -> Option<Ipv4Addr> {
                None
            }
        }

        let collected: Arc<Mutex<Vec<PingTick>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&collected);

        let handle = start(
            vec![HostSpec {
                id: "bad".into(),
                label: "Bad".into(),
                target: "nope.invalid".into(),
            }],
            MonitorConfig {
                interval: Duration::from_millis(50),
                timeout: Duration::from_millis(100),
                ttl: DEFAULT_TTL,
            },
            Arc::new(MockBackend::new(1000)),
            Arc::new(DnsCache::new(Arc::new(NoDns), Duration::from_secs(60))),
            move |tick| sink.lock().unwrap().push(tick),
        );

        tokio::time::sleep(Duration::from_millis(250)).await;
        handle.stop();

        let ticks = collected.lock().unwrap();
        let all = ticks.iter().flat_map(|t| &t.results).collect::<Vec<_>>();
        assert!(!all.is_empty(), "a failing host must still report");
        assert!(
            all.iter().all(|r| r.status == PingStatus::DnsFailure),
            "expected DnsFailure for every result"
        );
        assert!(all.iter().all(|r| r.rtt_us.is_none()));
    }

    /// End-to-end: the real Win32 backend driven by the real scheduler.
    /// Loopback keeps it deterministic and independent of the network.
    #[cfg(windows)]
    #[tokio::test]
    async fn real_backend_produces_successful_ticks_over_loopback() {
        use crate::icmp::windows::WindowsIcmp;

        let collected: Arc<Mutex<Vec<PingTick>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&collected);

        let handle = start(
            vec![HostSpec {
                id: "loop".into(),
                label: "Loopback".into(),
                target: "127.0.0.1".into(),
            }],
            MonitorConfig {
                interval: Duration::from_millis(50),
                timeout: Duration::from_millis(500),
                ttl: DEFAULT_TTL,
            },
            Arc::new(WindowsIcmp),
            Arc::new(DnsCache::new(
                Arc::new(SystemResolver),
                Duration::from_secs(60),
            )),
            move |tick| sink.lock().unwrap().push(tick),
        );

        tokio::time::sleep(Duration::from_millis(400)).await;
        handle.stop();

        let ticks = collected.lock().unwrap();
        let results: Vec<_> = ticks.iter().flat_map(|t| &t.results).collect();
        assert!(!results.is_empty(), "expected real ping results");
        assert!(
            results.iter().any(|r| r.status == PingStatus::Success),
            "loopback should succeed; got {:?}",
            results.iter().map(|r| r.status).collect::<Vec<_>>()
        );
        assert!(
            results
                .iter()
                .filter(|r| r.status == PingStatus::Success)
                .all(|r| r.rtt_us.is_some()),
            "a successful ping must carry an RTT"
        );
    }

    #[test]
    fn system_resolver_is_wired_up() {
        // Guards against the trait object silently defaulting to something else.
        assert!(SystemResolver.resolve("localhost").is_some());
    }
}
