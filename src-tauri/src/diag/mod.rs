//! Working out *why* a watched connection dropped.
//!
//! A ladder of checks, cheapest and most local first, stopping as soon as one of
//! them explains the failure. The point is to answer the question you would
//! otherwise answer by hand — is it my machine, my network, my ISP, or the far
//! end — before the evidence goes stale.
//!
//! The rungs are a pure function over a [`Probes`] trait, exactly like
//! [`crate::icmp::PingBackend`], so every conclusion can be tested without
//! touching a network. [`LiveProbes`] is the real one.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::adapters::Adapter;
use crate::icmp::PingBackend;
use crate::probe::PortState;
use crate::trace::{Hop, TraceConfig};

/// Stand-in for "the internet". Cloudflare's resolver, chosen because it answers
/// ICMP, answers TCP on 443, and is not going anywhere.
pub const INTERNET_CHECK: Ipv4Addr = Ipv4Addr::new(1, 1, 1, 1);

/// Port used to confirm the internet is reachable when ICMP is filtered.
const INTERNET_CHECK_PORT: u16 = 443;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    /// Is this machine on a network at all?
    Adapters,
    /// Can it reach its own router?
    Gateway,
    /// Can it reach the internet?
    Internet,
    /// Is the far end answering at all?
    Host,
    /// Is the far end answering on *that port*?
    Service,
    /// Where does the path stop?
    Path,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepOutcome {
    Pass,
    Fail,
    /// Not run, because an earlier rung made it pointless or there was nothing
    /// to test.
    Skipped,
    /// Cannot be run at all — every ICMP rung against an IPv6 peer, since the
    /// engine is IPv4-only.
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub kind: StepKind,
    pub label: String,
    pub outcome: StepOutcome,
    pub detail: String,
}

/// What the ladder settled on.
///
/// Deliberately few. Each one implies a different next move, and a taxonomy
/// finer than that would be guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Conclusion {
    /// No adapter is up with a gateway.
    NoNetwork,
    /// Neither the gateway nor the internet answered.
    LocalNetwork,
    /// The gateway answered but the internet did not.
    UpstreamDown,
    /// The network is fine; the far end is not answering.
    HostUnreachable,
    /// The host answered, but nothing is listening on that port.
    ServiceGone,
    /// The host is reachable but the connection is not getting through.
    Filtered,
    /// It connects again right now.
    Recovered,
    /// Everything tested was healthy, or there was nothing to test.
    Inconclusive,
}

impl Conclusion {
    pub fn summary(self) -> &'static str {
        match self {
            Conclusion::NoNetwork => "This machine is off the network.",
            Conclusion::LocalNetwork => "The local network is not reachable.",
            Conclusion::UpstreamDown => "The internet is not reachable from here.",
            Conclusion::HostUnreachable => "The network is fine, but the host is not answering.",
            Conclusion::ServiceGone => "The host is up, but nothing is listening on that port.",
            Conclusion::Filtered => "The host is reachable, but the connection is being blocked.",
            Conclusion::Recovered => "It connects again now, so the drop was transient.",
            Conclusion::Inconclusive => "Everything tested was healthy.",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub watch_id: String,
    pub label: String,
    /// Unix epoch milliseconds, taken when the diagnosis started.
    pub at: i64,
    /// What was probed, as `host:port`. `None` when the watch had no peer to
    /// name — a process watch whose application had already stopped talking.
    pub target: Option<String>,
    /// True when the user asked for it rather than a drop triggering it.
    pub manual: bool,
    pub steps: Vec<Step>,
    pub conclusion: Conclusion,
}

/// Streamed while a diagnosis runs.
///
/// A full ladder ending in a traceroute can take the better part of a minute,
/// and a panel that shows nothing until then is indistinguishable from one that
/// has hung.
///
/// The step is nested rather than flattened into the variant: an internally
/// tagged enum writes its tag as a field, and [`Step`] already has a `kind` of
/// its own — flattening would emit two of them and let the wrong one win.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum DiagEvent {
    Started {
        watch_id: String,
        label: String,
        target: Option<String>,
        at: i64,
        manual: bool,
    },
    Step {
        step: Step,
    },
    Done {
        report: Report,
    },
}

/// The probes the ladder is allowed to make.
///
/// Narrow on purpose: everything here is a question with a yes/no answer, which
/// is what keeps the reasoning testable.
pub trait Probes {
    fn adapters(&self) -> Vec<Adapter>;
    /// Round-trip time in microseconds, or `None` if nothing answered.
    fn ping(&self, ip: Ipv4Addr) -> Option<u32>;
    fn tcp(&self, ip: IpAddr, port: u16) -> PortState;
    fn trace(&self, ip: Ipv4Addr) -> Vec<Hop>;
}

fn ms(rtt_us: u32) -> String {
    format!("{:.1} ms", rtt_us as f64 / 1000.0)
}

struct Ladder<'a> {
    steps: Vec<Step>,
    on_step: &'a mut dyn FnMut(&Step),
}

impl Ladder<'_> {
    fn push(
        &mut self,
        kind: StepKind,
        label: &str,
        outcome: StepOutcome,
        detail: impl Into<String>,
    ) {
        let step = Step {
            kind,
            label: label.into(),
            outcome,
            detail: detail.into(),
        };
        (self.on_step)(&step);
        self.steps.push(step);
    }
}

/// Runs the ladder, reporting each rung as it completes.
///
/// `target` is the peer the connection was talking to. It is optional because a
/// whole-process watch names no peer of its own — if the application had already
/// stopped talking by the time anyone looked, there is nothing to probe, and
/// saying so is better than probing something arbitrary.
pub fn run(
    target: Option<SocketAddr>,
    probes: &dyn Probes,
    on_step: &mut dyn FnMut(&Step),
) -> (Vec<Step>, Conclusion) {
    let mut l = Ladder {
        steps: Vec::new(),
        on_step,
    };

    // 1. Is this machine on a network at all? Nothing below matters if not, and
    //    this rung costs no packets.
    let adapters = probes.adapters();
    let usable: Vec<&Adapter> = adapters
        .iter()
        .filter(|a| a.active && !a.gateways.is_empty())
        .collect();

    if usable.is_empty() {
        l.push(
            StepKind::Adapters,
            "Network adapters",
            StepOutcome::Fail,
            "No adapter is up with a gateway.",
        );
        return (l.steps, Conclusion::NoNetwork);
    }

    let names: Vec<&str> = usable.iter().map(|a| a.name.as_str()).collect();
    l.push(
        StepKind::Adapters,
        "Network adapters",
        StepOutcome::Pass,
        format!("Up with a gateway: {}.", names.join(", ")),
    );

    // 2. The router. Not conclusive on its own — plenty of networks filter ICMP
    //    to the gateway while routing perfectly well — so a failure here waits
    //    for the internet check to confirm it.
    let mut answered = Vec::new();
    let mut silent = Vec::new();
    for a in &usable {
        for gw in &a.gateways {
            // IPv6 gateways and link-local addresses are skipped rather than
            // reported as failures: the ICMP engine is IPv4-only.
            let Ok(ip) = gw.parse::<Ipv4Addr>() else {
                continue;
            };
            match probes.ping(ip) {
                Some(rtt) => answered.push(format!("{} {} in {}", a.name, gw, ms(rtt))),
                None => silent.push(format!("{} {}", a.name, gw)),
            }
        }
    }

    let gateway_ok = !answered.is_empty();
    if answered.is_empty() && silent.is_empty() {
        l.push(
            StepKind::Gateway,
            "Default gateway",
            StepOutcome::Skipped,
            "No IPv4 gateway to test.",
        );
    } else if gateway_ok {
        let mut detail = format!("Answered: {}.", answered.join("; "));
        if !silent.is_empty() {
            detail.push_str(&format!(" No answer from {}.", silent.join("; ")));
        }
        l.push(
            StepKind::Gateway,
            "Default gateway",
            StepOutcome::Pass,
            detail,
        );
    } else {
        l.push(
            StepKind::Gateway,
            "Default gateway",
            StepOutcome::Fail,
            format!("No answer from {}.", silent.join("; ")),
        );
    }

    // 3. The internet. ICMP first, then a TCP connection — a network that drops
    //    ping but routes traffic is common enough that concluding "the internet
    //    is down" from one silent echo would be wrong most of the time.
    let internet_ok = match probes.ping(INTERNET_CHECK) {
        Some(rtt) => {
            l.push(
                StepKind::Internet,
                "Internet",
                StepOutcome::Pass,
                format!("{INTERNET_CHECK} answered in {}.", ms(rtt)),
            );
            true
        }
        None => match probes.tcp(IpAddr::V4(INTERNET_CHECK), INTERNET_CHECK_PORT) {
            PortState::Open | PortState::Refused => {
                l.push(
                    StepKind::Internet,
                    "Internet",
                    StepOutcome::Pass,
                    format!(
                        "{INTERNET_CHECK} ignored ping but accepted a connection on \
                         {INTERNET_CHECK_PORT} — ICMP is filtered on this network, not broken."
                    ),
                );
                true
            }
            PortState::Filtered => {
                l.push(
                    StepKind::Internet,
                    "Internet",
                    StepOutcome::Fail,
                    format!("{INTERNET_CHECK} answered neither ping nor a connection on {INTERNET_CHECK_PORT}."),
                );
                false
            }
        },
    };

    if !internet_ok {
        // The gateway rung decides which side of the router the fault is on.
        return (
            l.steps,
            if gateway_ok {
                Conclusion::UpstreamDown
            } else {
                Conclusion::LocalNetwork
            },
        );
    }

    let Some(target) = target else {
        l.push(
            StepKind::Host,
            "The host",
            StepOutcome::Skipped,
            "This watch had no peer recorded, so there was nothing to probe.",
        );
        return (l.steps, Conclusion::Inconclusive);
    };

    // 4. The far end. A silent host is not proof of anything on its own — hosts
    //    that drop ICMP are ordinary — so the service check runs either way.
    let host_ok = match target.ip() {
        IpAddr::V4(ip) => match probes.ping(ip) {
            Some(rtt) => {
                l.push(
                    StepKind::Host,
                    "The host",
                    StepOutcome::Pass,
                    format!("{ip} answered in {}.", ms(rtt)),
                );
                Some(true)
            }
            None => {
                l.push(
                    StepKind::Host,
                    "The host",
                    StepOutcome::Fail,
                    format!("{ip} did not answer a ping."),
                );
                Some(false)
            }
        },
        IpAddr::V6(ip) => {
            l.push(
                StepKind::Host,
                "The host",
                StepOutcome::Unsupported,
                format!("{ip} is IPv6, and the ICMP engine is IPv4-only."),
            );
            None
        }
    };

    // 5. The rung that actually reproduces the failure: the same connection the
    //    application was making. Works for IPv6 too.
    let port = target.port();
    let service = probes.tcp(target.ip(), port);
    match service {
        PortState::Open => {
            l.push(
                StepKind::Service,
                "The service",
                StepOutcome::Pass,
                format!("Connected to port {port} — it is accepting connections now."),
            );
            return (l.steps, Conclusion::Recovered);
        }
        PortState::Refused => {
            l.push(
                StepKind::Service,
                "The service",
                StepOutcome::Fail,
                format!(
                    "Port {port} actively refused the connection, so the host is up but nothing \
                     is listening."
                ),
            );
            return (l.steps, Conclusion::ServiceGone);
        }
        PortState::Filtered => l.push(
            StepKind::Service,
            "The service",
            StepOutcome::Fail,
            format!("Port {port} did not answer at all."),
        ),
    }

    // 6. The only case that needs to know *where* the path breaks, and the only
    //    one expensive enough to be worth gating this carefully.
    match (host_ok, target.ip()) {
        (Some(true), _) => {
            l.push(
                StepKind::Path,
                "The path",
                StepOutcome::Skipped,
                "The host itself answers, so the path is intact and only the port is blocked.",
            );
            (l.steps, Conclusion::Filtered)
        }
        (_, IpAddr::V6(_)) => {
            l.push(
                StepKind::Path,
                "The path",
                StepOutcome::Unsupported,
                "Traceroute is IPv4-only.",
            );
            (l.steps, Conclusion::Filtered)
        }
        (_, IpAddr::V4(ip)) => {
            let hops = probes.trace(ip);
            let reached = hops.iter().any(|h| h.reached);
            let last = hops.iter().rev().find_map(|h| h.addr.clone());

            if reached {
                // ICMP crosses the path but TCP does not: a firewall on the port,
                // not a broken route.
                l.push(
                    StepKind::Path,
                    "The path",
                    StepOutcome::Pass,
                    format!("The route reaches {ip} in {} hops.", hops.len()),
                );
                (l.steps, Conclusion::Filtered)
            } else {
                let detail = match last {
                    Some(addr) => format!(
                        "The route stops after {} hops; the last reply came from {addr}.",
                        hops.len()
                    ),
                    None => "Nothing along the route replied at all.".into(),
                };
                l.push(StepKind::Path, "The path", StepOutcome::Fail, detail);
                (l.steps, Conclusion::HostUnreachable)
            }
        }
    }
}

/// How long to wait for one echo. Shorter than the ping engine's default: this
/// runs six rungs back to back, and a slow answer is a failure for our purposes.
const PING_TIMEOUT: Duration = Duration::from_millis(1500);

/// One lost packet is not a diagnosis.
const PING_ATTEMPTS: u8 = 2;

/// Long enough for a refusal to win the race against the timeout — see
/// [`crate::probe::check_port`], where that is measured.
const TCP_TIMEOUT: Duration = Duration::from_secs(2);

/// The real probes.
pub struct LiveProbes {
    pub backend: Arc<dyn PingBackend>,
    pub cancelled: Arc<AtomicBool>,
}

impl LiveProbes {
    fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

impl Probes for LiveProbes {
    fn adapters(&self) -> Vec<Adapter> {
        // A diagnosis that cannot read the adapter list is still worth running;
        // the rung simply fails.
        crate::adapters::list().unwrap_or_default()
    }

    fn ping(&self, ip: Ipv4Addr) -> Option<u32> {
        for _ in 0..PING_ATTEMPTS {
            if self.stopped() {
                return None;
            }
            let outcome = self
                .backend
                .echo(ip, crate::monitor::DEFAULT_TTL, PING_TIMEOUT);
            if outcome.status.is_success() {
                // A sub-microsecond reply on loopback still counts as answered.
                return Some(outcome.rtt_us.unwrap_or(0));
            }
        }
        None
    }

    fn tcp(&self, ip: IpAddr, port: u16) -> PortState {
        if self.stopped() {
            return PortState::Filtered;
        }
        crate::probe::check_port(ip, port, TCP_TIMEOUT).state
    }

    fn trace(&self, ip: Ipv4Addr) -> Vec<Hop> {
        // Tighter than the manual traceroute on every axis. This one runs
        // unattended after a drop, and its only job is to find where the path
        // stops — not to produce a readable table.
        let cfg = TraceConfig {
            max_hops: 20,
            probes: 2,
            timeout_ms: 1000,
            silent_limit: 5,
        };
        let mut hops = Vec::new();
        crate::trace::run(&*self.backend, ip, &cfg, &self.cancelled, |hop| {
            hops.push(hop.clone())
        });
        hops
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scripted answers, so each rung can be failed in isolation.
    #[derive(Default)]
    struct Fake {
        adapters: Vec<Adapter>,
        /// Addresses that answer ICMP. Everything else is silent.
        pings: Vec<Ipv4Addr>,
        tcp: Vec<(IpAddr, u16, PortState)>,
        /// Default for any address not listed in `tcp`.
        tcp_default: Option<PortState>,
        hops: Vec<Hop>,
    }

    impl Probes for Fake {
        fn adapters(&self) -> Vec<Adapter> {
            self.adapters.clone()
        }
        fn ping(&self, ip: Ipv4Addr) -> Option<u32> {
            self.pings.contains(&ip).then_some(1_500)
        }
        fn tcp(&self, ip: IpAddr, port: u16) -> PortState {
            self.tcp
                .iter()
                .find(|(a, p, _)| *a == ip && *p == port)
                .map(|(_, _, s)| *s)
                .or(self.tcp_default)
                .unwrap_or(PortState::Filtered)
        }
        fn trace(&self, _ip: Ipv4Addr) -> Vec<Hop> {
            self.hops.clone()
        }
    }

    fn adapter(name: &str, gateways: &[&str], active: bool) -> Adapter {
        Adapter {
            luid: name.into(),
            name: name.into(),
            description: name.into(),
            kind: "Ethernet".into(),
            status: if active { "Up" } else { "Down" }.into(),
            mac: None,
            mtu: Some(1500),
            speed_bps: None,
            addresses: vec!["192.168.1.5/24".into()],
            gateways: gateways.iter().map(|g| (*g).to_string()).collect(),
            dns: vec![],
            dhcp_server: None,
            active,
        }
    }

    fn hop(ttl: u8, addr: Option<&str>, reached: bool) -> Hop {
        Hop {
            ttl,
            addr: addr.map(Into::into),
            rtts_us: vec![Some(1_000)],
            status: crate::icmp::PingStatus::Success,
            reached,
        }
    }

    /// A healthy machine: one adapter up, gateway and internet both answering.
    fn healthy() -> Fake {
        Fake {
            adapters: vec![adapter("Ethernet", &["192.168.1.1"], true)],
            pings: vec![Ipv4Addr::new(192, 168, 1, 1), INTERNET_CHECK],
            ..Default::default()
        }
    }

    fn target(addr: &str, port: u16) -> Option<SocketAddr> {
        Some(SocketAddr::new(addr.parse().unwrap(), port))
    }

    fn diagnose(target: Option<SocketAddr>, probes: &dyn Probes) -> (Vec<Step>, Conclusion) {
        run(target, probes, &mut |_| {})
    }

    fn kinds(steps: &[Step]) -> Vec<StepKind> {
        steps.iter().map(|s| s.kind).collect()
    }

    #[test]
    fn no_adapter_with_a_gateway_stops_immediately() {
        // The cheapest rung, and the one that makes every other answer moot.
        let fake = Fake {
            adapters: vec![
                adapter("Ethernet", &[], true),
                adapter("Wi-Fi", &["10.0.0.1"], false),
            ],
            ..Default::default()
        };
        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::NoNetwork);
        assert_eq!(kinds(&steps), vec![StepKind::Adapters]);
    }

    #[test]
    fn a_silent_gateway_and_a_silent_internet_is_a_local_fault() {
        let fake = Fake {
            adapters: vec![adapter("Ethernet", &["192.168.1.1"], true)],
            ..Default::default()
        };
        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::LocalNetwork);
        // Stops at the internet rung; the host is never probed.
        assert_eq!(
            kinds(&steps),
            vec![StepKind::Adapters, StepKind::Gateway, StepKind::Internet]
        );
    }

    #[test]
    fn a_reachable_gateway_with_no_internet_blames_upstream() {
        let fake = Fake {
            adapters: vec![adapter("Ethernet", &["192.168.1.1"], true)],
            pings: vec![Ipv4Addr::new(192, 168, 1, 1)],
            ..Default::default()
        };
        let (_, conclusion) = diagnose(target("1.2.3.4", 443), &fake);
        assert_eq!(conclusion, Conclusion::UpstreamDown);
    }

    #[test]
    fn a_filtered_gateway_does_not_fake_a_local_fault() {
        // The reason the gateway rung is not conclusive on its own: plenty of
        // networks drop ICMP to the router and route traffic perfectly well.
        let mut fake = healthy();
        fake.pings = vec![INTERNET_CHECK];
        fake.tcp_default = Some(PortState::Open);

        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::Recovered);
        let gateway = &steps[1];
        assert_eq!(gateway.outcome, StepOutcome::Fail);
    }

    #[test]
    fn ping_being_filtered_does_not_fake_a_dead_internet() {
        // Risk one from the plan, in miniature: a network that drops ICMP but
        // routes fine must not be reported as having no internet.
        let fake = Fake {
            adapters: vec![adapter("Ethernet", &["192.168.1.1"], true)],
            tcp: vec![(
                IpAddr::V4(INTERNET_CHECK),
                INTERNET_CHECK_PORT,
                PortState::Open,
            )],
            ..Default::default()
        };
        let (steps, conclusion) = diagnose(None, &fake);

        assert_eq!(conclusion, Conclusion::Inconclusive);
        let internet = &steps[2];
        assert_eq!(internet.outcome, StepOutcome::Pass);
        assert!(internet.detail.contains("ICMP is filtered"));
    }

    #[test]
    fn a_watch_with_no_peer_stops_after_the_network_checks() {
        // A process watch whose application had already gone quiet. Better to
        // say so than to probe something arbitrary.
        let (steps, conclusion) = diagnose(None, &healthy());

        assert_eq!(conclusion, Conclusion::Inconclusive);
        assert_eq!(steps.last().unwrap().kind, StepKind::Host);
        assert_eq!(steps.last().unwrap().outcome, StepOutcome::Skipped);
    }

    #[test]
    fn a_port_that_connects_again_is_a_transient_drop() {
        let mut fake = healthy();
        fake.pings.push(Ipv4Addr::new(1, 2, 3, 4));
        fake.tcp = vec![("1.2.3.4".parse().unwrap(), 443, PortState::Open)];

        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::Recovered);
        // No traceroute: nothing to find.
        assert!(!kinds(&steps).contains(&StepKind::Path));
    }

    #[test]
    fn a_refused_port_means_the_service_went_away_not_the_network() {
        let mut fake = healthy();
        fake.pings.push(Ipv4Addr::new(1, 2, 3, 4));
        fake.tcp = vec![("1.2.3.4".parse().unwrap(), 443, PortState::Refused)];

        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::ServiceGone);
        assert!(!kinds(&steps).contains(&StepKind::Path));
    }

    #[test]
    fn a_host_that_answers_but_a_port_that_does_not_is_filtered() {
        let mut fake = healthy();
        fake.pings.push(Ipv4Addr::new(1, 2, 3, 4));
        fake.tcp = vec![("1.2.3.4".parse().unwrap(), 443, PortState::Filtered)];

        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::Filtered);
        // The path rung is skipped rather than run: the host answering already
        // proves the route is intact, and a traceroute is the expensive rung.
        let path = steps.last().unwrap();
        assert_eq!(path.kind, StepKind::Path);
        assert_eq!(path.outcome, StepOutcome::Skipped);
    }

    #[test]
    fn a_silent_host_and_a_dead_port_earns_a_traceroute() {
        let mut fake = healthy();
        fake.hops = vec![
            hop(1, Some("192.168.1.1"), false),
            hop(2, Some("10.0.0.1"), false),
        ];

        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::HostUnreachable);
        let path = steps.last().unwrap();
        assert_eq!(path.outcome, StepOutcome::Fail);
        assert!(path.detail.contains("10.0.0.1"), "{}", path.detail);
    }

    #[test]
    fn a_traceroute_that_arrives_means_the_port_is_blocked_not_the_route() {
        // ICMP crosses the path and TCP does not: a firewall on the port.
        let mut fake = healthy();
        fake.hops = vec![
            hop(1, Some("192.168.1.1"), false),
            hop(2, Some("1.2.3.4"), true),
        ];

        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::Filtered);
        assert_eq!(steps.last().unwrap().outcome, StepOutcome::Pass);
    }

    #[test]
    fn a_route_where_nothing_replies_says_so() {
        let fake = healthy();
        let (steps, conclusion) = diagnose(target("1.2.3.4", 443), &fake);

        assert_eq!(conclusion, Conclusion::HostUnreachable);
        assert!(steps
            .last()
            .unwrap()
            .detail
            .contains("Nothing along the route"));
    }

    #[test]
    fn an_ipv6_peer_skips_the_icmp_rungs_but_still_tests_the_port() {
        // The engine is IPv4-only. Saying so beats silently passing.
        let mut fake = healthy();
        fake.tcp = vec![("2606:4700::1111".parse().unwrap(), 443, PortState::Refused)];

        let (steps, conclusion) = diagnose(target("2606:4700::1111", 443), &fake);

        assert_eq!(conclusion, Conclusion::ServiceGone);
        let host = steps.iter().find(|s| s.kind == StepKind::Host).unwrap();
        assert_eq!(host.outcome, StepOutcome::Unsupported);
    }

    #[test]
    fn an_ipv6_peer_that_is_filtered_does_not_claim_a_traceroute_it_cannot_run() {
        let mut fake = healthy();
        fake.tcp_default = Some(PortState::Filtered);

        let (steps, conclusion) = diagnose(target("2606:4700::1111", 443), &fake);

        assert_eq!(conclusion, Conclusion::Filtered);
        let path = steps.last().unwrap();
        assert_eq!(path.kind, StepKind::Path);
        assert_eq!(path.outcome, StepOutcome::Unsupported);
    }

    #[test]
    fn an_ipv6_gateway_is_skipped_rather_than_failed() {
        let mut fake = healthy();
        fake.adapters = vec![adapter("Ethernet", &["fe80::1"], true)];

        let (steps, _) = diagnose(None, &fake);

        let gateway = &steps[1];
        assert_eq!(gateway.outcome, StepOutcome::Skipped);
        assert!(gateway.detail.contains("No IPv4 gateway"));
    }

    #[test]
    fn every_rung_is_reported_as_it_completes() {
        // The panel draws from these; a report that only arrives at the end
        // looks like a hang.
        let mut seen = Vec::new();
        let (steps, _) = run(target("1.2.3.4", 443), &healthy(), &mut |s| {
            seen.push(s.kind)
        });

        assert_eq!(seen, kinds(&steps));
        assert!(!seen.is_empty());
    }

    #[test]
    fn every_conclusion_reads_as_a_sentence() {
        for c in [
            Conclusion::NoNetwork,
            Conclusion::LocalNetwork,
            Conclusion::UpstreamDown,
            Conclusion::HostUnreachable,
            Conclusion::ServiceGone,
            Conclusion::Filtered,
            Conclusion::Recovered,
            Conclusion::Inconclusive,
        ] {
            assert!(c.summary().ends_with('.'), "{c:?}");
        }
    }

    #[test]
    fn a_step_event_keeps_its_own_kind() {
        // The tag is `event`, not `kind`, because a step already has a kind. Get
        // this wrong and the JSON carries two `kind` keys, the frontend reads
        // the last one, and every event looks like a step of the wrong type.
        let event = DiagEvent::Step {
            step: Step {
                kind: StepKind::Gateway,
                label: "Default gateway".into(),
                outcome: StepOutcome::Pass,
                detail: "ok".into(),
            },
        };
        let json = serde_json::to_string(&event).unwrap();

        assert!(json.contains("\"event\":\"step\""), "{json}");
        assert!(json.contains("\"kind\":\"gateway\""), "{json}");
        assert_eq!(json.matches("\"kind\"").count(), 1, "{json}");
    }

    /// Runs the real ladder against the real network. Ignored by default so the
    /// suite stays offline; run with `cargo test -- --ignored --nocapture` to
    /// read the rungs.
    #[cfg(windows)]
    fn live(target: &str) -> (Vec<Step>, Conclusion) {
        let probes = LiveProbes {
            backend: Arc::new(crate::icmp::windows::WindowsIcmp),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let (steps, conclusion) = run(Some(target.parse().unwrap()), &probes, &mut |s| {
            println!("  {:?} {:?} — {}", s.kind, s.outcome, s.detail)
        });
        println!("  => {conclusion:?}: {}", conclusion.summary());
        (steps, conclusion)
    }

    #[test]
    #[ignore]
    #[cfg(windows)]
    fn live_ladder_finds_a_healthy_service() {
        // The rungs all pass and the port opens, so there is no fault to find.
        let (_, conclusion) = live("1.1.1.1:443");
        assert_eq!(conclusion, Conclusion::Recovered);
    }

    #[test]
    #[ignore]
    #[cfg(windows)]
    fn live_ladder_walks_the_path_to_an_unroutable_host() {
        // TEST-NET-1, reserved for documentation and routed nowhere.
        let (steps, conclusion) = live("192.0.2.1:443");
        assert_eq!(conclusion, Conclusion::HostUnreachable);
        assert_eq!(steps.last().unwrap().kind, StepKind::Path);
    }

    #[test]
    fn a_report_round_trips_as_camel_case() {
        let report = Report {
            watch_id: "w1".into(),
            label: "chrome → 1.1.1.1:443".into(),
            at: 1,
            target: Some("1.1.1.1:443".into()),
            manual: true,
            steps: vec![Step {
                kind: StepKind::Adapters,
                label: "Network adapters".into(),
                outcome: StepOutcome::Pass,
                detail: "ok".into(),
            }],
            conclusion: Conclusion::Recovered,
        };
        let json = serde_json::to_string(&report).unwrap();

        assert!(json.contains("watchId"), "{json}");
        assert!(json.contains("\"conclusion\":\"recovered\""), "{json}");
        assert!(json.contains("\"outcome\":\"pass\""), "{json}");
    }
}
