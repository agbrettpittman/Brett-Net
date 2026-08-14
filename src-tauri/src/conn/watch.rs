//! Watching a connection, and working out why it went away.
//!
//! Everything here is a pure function over two consecutive snapshots of the
//! connection table. The polling loop that produces those snapshots lives in
//! `lib.rs`; keeping the reasoning separate is what makes it testable, and this
//! is the part where being wrong is expensive — a misclassified drop sends the
//! whole diagnosis down the wrong path.

use serde::{Deserialize, Serialize};

use super::Connection;

/// What to keep an eye on, at one of three widths.
///
/// The fields narrow the match rather than selecting a mode, so one shape
/// covers all three:
///
/// | Set | Watches |
/// |---|---|
/// | `process` only | everything that application is talking to |
/// | `process` + `remote_*` | that application's conversation with one peer |
/// | `socket` | one exact five-tuple |
///
/// The middle one is the right default for anything that pools connections.
/// Six sockets to the same server churning constantly is one healthy
/// conversation, and watching any single one would report a death every few
/// seconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSpec {
    pub id: String,
    /// `None` matches any peer, which is what makes a whole-process watch
    /// possible.
    pub remote_addr: Option<String>,
    pub remote_port: Option<u16>,
    /// Matched by executable name, not PID, so an application restarting does
    /// not read as the connection dying.
    pub process: Option<String>,
    /// The exact five-tuple, when only one socket counts.
    pub socket: Option<String>,
    /// Shown in the UI, and in the event log after the connection is gone.
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// The owning process is no longer running, so nothing about the network
    /// is in question.
    ProcessExited,
    /// This machine closed it, and did so properly.
    LocalClosed,
    /// The far end closed it, and did so properly.
    RemoteClosed,
    /// It never reached ESTABLISHED — the handshake did not complete.
    NeverConnected,
    /// It vanished straight out of ESTABLISHED with no shutdown at all: a
    /// reset, a timeout, or the path failing underneath it. The only verdict
    /// worth escalating to a network diagnosis.
    Abrupt,
}

impl Verdict {
    /// Whether this is worth spending network probes on.
    pub fn needs_diagnosis(self) -> bool {
        self == Verdict::Abrupt
    }

    pub fn summary(self) -> &'static str {
        match self {
            Verdict::ProcessExited => "the process exited",
            Verdict::LocalClosed => "this machine closed it",
            Verdict::RemoteClosed => "the far end closed it",
            Verdict::NeverConnected => "it never finished connecting",
            Verdict::Abrupt => "it dropped without being closed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub watch_id: String,
    pub label: String,
    /// Unix epoch milliseconds.
    pub at: i64,
    /// True for a recovery, false for a drop.
    pub up: bool,
    /// Absent on a recovery.
    pub verdict: Option<Verdict>,
    pub detail: String,
}

/// States in which a connection is carrying, or about to carry, traffic.
///
/// Everything else is wreckage. `Time wait` in particular lingers for minutes
/// after a clean close, so counting it as alive would report a connection as
/// healthy long after it ended.
pub fn is_live(state: &str) -> bool {
    matches!(state, "Established" | "SYN sent" | "SYN received")
}

/// Whether a connection is one this watch cares about.
pub fn matches(spec: &WatchSpec, c: &Connection) -> bool {
    if let Some(socket) = &spec.socket {
        return &c.id == socket;
    }
    // A spec that narrows by nothing would match every connection on the
    // machine, so it matches none instead. Only reachable from a malformed
    // payload, but the failure would be silent and very confusing.
    if spec.remote_addr.is_none() && spec.process.is_none() {
        return false;
    }

    if spec
        .remote_addr
        .as_ref()
        .is_some_and(|a| &c.remote_addr != a)
    {
        return false;
    }
    if spec.remote_port.is_some_and(|p| c.remote_port != p) {
        return false;
    }

    match (&spec.process, &c.process) {
        (Some(want), Some(have)) => want.eq_ignore_ascii_case(have),
        // A watch naming a process cannot be satisfied by a row we could not
        // name; saying otherwise would attribute someone else's socket to it.
        (Some(_), None) => false,
        (None, _) => true,
    }
}

/// The connections a watch currently applies to.
pub fn matching<'a>(spec: &WatchSpec, snapshot: &'a [Connection]) -> Vec<&'a Connection> {
    snapshot.iter().filter(|c| matches(spec, c)).collect()
}

/// What is left of a set of connections in a later snapshot.
///
/// Matched by five-tuple rather than by re-running the watch, because **a
/// closing socket loses its owner**: Windows reports `Time wait` rows against
/// PID 0, so a watch that names a process stops matching its own remnants. That
/// made every clean local close look like an abrupt drop — the socket appeared
/// to vanish when it had merely stopped being attributable.
pub fn remnants<'a>(before: &[&Connection], snapshot: &'a [Connection]) -> Vec<&'a Connection> {
    let ids: std::collections::HashSet<&str> = before.iter().map(|c| c.id.as_str()).collect();
    snapshot
        .iter()
        .filter(|c| ids.contains(c.id.as_str()))
        .collect()
}

/// Whether the watch is satisfied right now.
pub fn is_up(spec: &WatchSpec, snapshot: &[Connection]) -> bool {
    matching(spec, snapshot).iter().any(|c| is_live(&c.state))
}

/// Works out why a watch stopped being satisfied.
///
/// `before` and `after` are the matching connections either side of the
/// transition. The evidence is in what the established sockets *turned into*:
/// Windows leaves the closing states behind for long enough to be seen, so a
/// tidy shutdown looks quite different from a socket that simply ceased to
/// exist.
pub fn classify(
    before: &[&Connection],
    after: &[&Connection],
    process_running: bool,
) -> (Verdict, String) {
    if !process_running {
        return (
            Verdict::ProcessExited,
            "The owning process is no longer running, so the connection going away is expected."
                .into(),
        );
    }

    let remnants: Vec<&str> = after.iter().map(|c| c.state.as_str()).collect();

    if remnants
        .iter()
        .any(|s| matches!(*s, "Close wait" | "Last ACK"))
    {
        return (
            Verdict::RemoteClosed,
            format!(
                "The far end sent a FIN first — the socket is in {}.",
                remnants.join(", ")
            ),
        );
    }

    if remnants
        .iter()
        .any(|s| matches!(*s, "FIN wait 1" | "FIN wait 2" | "Time wait" | "Closing"))
    {
        return (
            Verdict::LocalClosed,
            format!(
                "This machine closed it and the shutdown completed normally — {}.",
                remnants.join(", ")
            ),
        );
    }

    // Nothing left behind at all.
    if !before.is_empty() && before.iter().all(|c| c.state == "SYN sent") {
        return (
            Verdict::NeverConnected,
            "The handshake never completed — no reply to the connection attempt.".into(),
        );
    }

    (
        Verdict::Abrupt,
        "The socket disappeared straight from ESTABLISHED with no shutdown: a reset, a timeout, \
         or the path failing underneath it."
            .into(),
    )
}

/// Tracks watches across successive snapshots and reports the transitions.
///
/// Holding the previous snapshot is what makes the classification possible: the
/// evidence for *why* a connection ended is the difference between what was
/// there and what is there now.
#[derive(Default)]
pub struct Watcher {
    specs: Vec<WatchSpec>,
    previous: Vec<Connection>,
    /// Last known state per watch. Absent means "not yet observed", which is
    /// deliberately different from "down" — a watch registered while its
    /// connection is already gone must not announce a drop that happened before
    /// anyone was looking.
    up: std::collections::HashMap<String, bool>,
}

impl Watcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the watch list. The frontend owns it and pushes the whole set,
    /// so there is no add/remove drift to reconcile.
    pub fn set_specs(&mut self, specs: Vec<WatchSpec>) {
        // Forget state for watches that are gone, or a re-added watch would
        // inherit a stale up/down from a previous life.
        let kept: std::collections::HashSet<&String> = specs.iter().map(|s| &s.id).collect();
        self.up.retain(|id, _| kept.contains(id));
        self.specs = specs;
    }

    pub fn specs(&self) -> &[WatchSpec] {
        &self.specs
    }

    /// Folds one snapshot in, returning whatever changed.
    ///
    /// `processes` is the set of running executable names, lower-cased.
    pub fn tick(
        &mut self,
        snapshot: Vec<Connection>,
        processes: &std::collections::HashSet<String>,
        at: i64,
    ) -> Vec<WatchEvent> {
        let mut events = Vec::new();

        for spec in &self.specs {
            let now_up = is_up(spec, &snapshot);

            match self.up.get(&spec.id).copied() {
                // First sighting: record it silently. Announcing here would
                // report a drop that happened before the watch existed.
                None => {}
                Some(was) if was == now_up => {}
                Some(false) => events.push(WatchEvent {
                    watch_id: spec.id.clone(),
                    label: spec.label.clone(),
                    at,
                    up: true,
                    verdict: None,
                    detail: "Connected again.".into(),
                }),
                Some(true) => {
                    let running = match &spec.process {
                        Some(name) => processes.contains(&name.to_ascii_lowercase()),
                        None => true,
                    };
                    let before = matching(spec, &self.previous);
                    let (verdict, detail) =
                        classify(&before, &remnants(&before, &snapshot), running);
                    events.push(WatchEvent {
                        watch_id: spec.id.clone(),
                        label: spec.label.clone(),
                        at,
                        up: false,
                        verdict: Some(verdict),
                        detail,
                    });
                }
            }

            self.up.insert(spec.id.clone(), now_up);
        }

        self.previous = snapshot;
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn running(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| n.to_ascii_lowercase()).collect()
    }

    fn conn(over: &[(&str, &str)]) -> Connection {
        let get = |k: &str, d: &str| {
            over.iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| *v)
                .unwrap_or(d)
                .to_string()
        };
        let state = get("state", "Established");
        let remote_addr = get("remote", "1.1.1.1");
        let process = get("process", "chrome.exe");

        Connection {
            id: get("id", "192.168.1.5:5000-1.1.1.1:443"),
            local_addr: "192.168.1.5".into(),
            local_port: 5000,
            remote_addr,
            remote_port: get("port", "443").parse().unwrap(),
            state,
            pid: 1234,
            process: (process != "-").then_some(process),
            v6: false,
        }
    }

    fn spec() -> WatchSpec {
        WatchSpec {
            id: "w1".into(),
            remote_addr: Some("1.1.1.1".into()),
            remote_port: Some(443),
            process: Some("chrome.exe".into()),
            socket: None,
            label: "chrome → 1.1.1.1:443".into(),
        }
    }

    #[test]
    fn only_carrying_states_count_as_live() {
        assert!(is_live("Established"));
        assert!(is_live("SYN sent"));
        // The one that matters: it lingers for minutes after a clean close.
        assert!(!is_live("Time wait"));
        assert!(!is_live("Close wait"));
        assert!(!is_live("Listen"));
    }

    #[test]
    fn an_endpoint_watch_matches_any_socket_to_that_peer() {
        // The whole point for a connection pool: six sockets churning is one
        // healthy conversation, not six deaths.
        let a = conn(&[("id", "a")]);
        let b = conn(&[("id", "b")]);
        assert!(matches(&spec(), &a) && matches(&spec(), &b));
        assert_eq!(matching(&spec(), &[a, b]).len(), 2);
    }

    #[test]
    fn an_endpoint_watch_ignores_other_peers_and_other_processes() {
        assert!(!matches(&spec(), &conn(&[("remote", "8.8.8.8")])));
        assert!(!matches(&spec(), &conn(&[("port", "80")])));
        assert!(!matches(&spec(), &conn(&[("process", "Teams.exe")])));
    }

    #[test]
    fn process_matching_ignores_case() {
        assert!(matches(&spec(), &conn(&[("process", "Chrome.EXE")])));
    }

    #[test]
    fn a_watch_naming_a_process_rejects_an_unnamed_socket() {
        // Otherwise another user's connection to the same host would be
        // attributed to this application.
        assert!(!matches(&spec(), &conn(&[("process", "-")])));
    }

    #[test]
    fn a_watch_with_no_process_takes_any_owner() {
        let any = WatchSpec {
            process: None,
            ..spec()
        };
        assert!(matches(&any, &conn(&[("process", "Teams.exe")])));
        assert!(matches(&any, &conn(&[("process", "-")])));
    }

    /// Watches everything one application is talking to, at any peer.
    fn process_spec() -> WatchSpec {
        WatchSpec {
            id: "p1".into(),
            remote_addr: None,
            remote_port: None,
            process: Some("GoogleDriveFS.exe".into()),
            socket: None,
            label: "GoogleDriveFS.exe — any peer".into(),
        }
    }

    #[test]
    fn a_process_watch_takes_every_peer() {
        let p = process_spec();
        assert!(matches(&p, &conn(&[("process", "GoogleDriveFS.exe")])));
        assert!(matches(
            &p,
            &conn(&[("process", "GoogleDriveFS.exe"), ("remote", "8.8.8.8")])
        ));
        assert!(matches(
            &p,
            &conn(&[("process", "GoogleDriveFS.exe"), ("port", "80")])
        ));
    }

    #[test]
    fn a_process_watch_still_excludes_other_applications() {
        assert!(!matches(
            &process_spec(),
            &conn(&[("process", "chrome.exe")])
        ));
        assert!(!matches(&process_spec(), &conn(&[("process", "-")])));
    }

    #[test]
    fn a_process_watch_is_up_while_any_connection_is_live() {
        let p = process_spec();
        let rows = [
            conn(&[
                ("process", "GoogleDriveFS.exe"),
                ("state", "Time wait"),
                ("id", "a"),
            ]),
            conn(&[
                ("process", "GoogleDriveFS.exe"),
                ("remote", "8.8.8.8"),
                ("id", "b"),
            ]),
        ];
        assert!(is_up(&p, &rows));

        // Only wreckage left: the application has stopped talking.
        let dead = [conn(&[
            ("process", "GoogleDriveFS.exe"),
            ("state", "Time wait"),
        ])];
        assert!(!is_up(&p, &dead));
    }

    #[test]
    fn a_process_watch_survives_the_peer_changing() {
        // Google Drive rotating between front-end addresses is not a drop.
        let mut w = Watcher::new();
        w.set_specs(vec![process_spec()]);
        let procs = running(&["googledrivefs.exe"]);

        w.tick(
            vec![conn(&[("process", "GoogleDriveFS.exe"), ("id", "a")])],
            &procs,
            0,
        );
        let events = w.tick(
            vec![conn(&[
                ("process", "GoogleDriveFS.exe"),
                ("remote", "172.217.113.4"),
                ("id", "b"),
            ])],
            &procs,
            1,
        );

        assert!(events.is_empty(), "got {events:?}");
    }

    #[test]
    fn a_spec_that_narrows_by_nothing_matches_nothing() {
        // Rather than matching every connection on the machine, which is the
        // sort of failure nobody would spot.
        let empty = WatchSpec {
            id: "bad".into(),
            remote_addr: None,
            remote_port: None,
            process: None,
            socket: None,
            label: String::new(),
        };
        assert!(!matches(&empty, &conn(&[])));
    }

    #[test]
    fn a_socket_watch_matches_exactly_one() {
        let only = WatchSpec {
            socket: Some("b".into()),
            ..spec()
        };
        assert!(!matches(&only, &conn(&[("id", "a")])));
        assert!(matches(&only, &conn(&[("id", "b")])));
    }

    #[test]
    fn a_socket_watch_ignores_the_endpoint_fields() {
        // The five-tuple is already unique, so the rest would only get in the
        // way — including for a socket to a peer the spec no longer names.
        let only = WatchSpec {
            socket: Some("b".into()),
            remote_addr: Some("9.9.9.9".into()),
            ..spec()
        };
        assert!(matches(&only, &conn(&[("id", "b")])));
    }

    #[test]
    fn a_watch_is_up_only_while_something_is_carrying() {
        let live = [conn(&[])];
        assert!(is_up(&spec(), &live));

        // Time wait is the trap: present in the table, long dead.
        let wreckage = [conn(&[("state", "Time wait")])];
        assert!(!is_up(&spec(), &wreckage));
        assert!(!is_up(&spec(), &[]));
    }

    #[test]
    fn a_dead_process_explains_it_without_blaming_the_network() {
        let before = [conn(&[])];
        let (verdict, _) = classify(&before.iter().collect::<Vec<_>>(), &[], false);
        assert_eq!(verdict, Verdict::ProcessExited);
        assert!(!verdict.needs_diagnosis());
    }

    #[test]
    fn close_wait_means_the_far_end_hung_up() {
        let before = [conn(&[])];
        let after = [conn(&[("state", "Close wait")])];
        let (verdict, detail) = classify(
            &before.iter().collect::<Vec<_>>(),
            &after.iter().collect::<Vec<_>>(),
            true,
        );
        assert_eq!(verdict, Verdict::RemoteClosed);
        assert!(detail.contains("Close wait"));
        assert!(!verdict.needs_diagnosis());
    }

    #[test]
    fn time_wait_means_this_machine_hung_up() {
        let before = [conn(&[])];
        let after = [conn(&[("state", "Time wait")])];
        let (verdict, _) = classify(
            &before.iter().collect::<Vec<_>>(),
            &after.iter().collect::<Vec<_>>(),
            true,
        );
        assert_eq!(verdict, Verdict::LocalClosed);
        assert!(!verdict.needs_diagnosis());
    }

    #[test]
    fn the_far_end_wins_when_both_kinds_of_remnant_are_present() {
        // A pool closing several sockets at once can leave a mixture. The
        // remote closing is the more informative half.
        let before = [conn(&[])];
        let after = [
            conn(&[("state", "Time wait"), ("id", "a")]),
            conn(&[("state", "Close wait"), ("id", "b")]),
        ];
        let (verdict, _) = classify(
            &before.iter().collect::<Vec<_>>(),
            &after.iter().collect::<Vec<_>>(),
            true,
        );
        assert_eq!(verdict, Verdict::RemoteClosed);
    }

    #[test]
    fn nothing_left_behind_is_abrupt_and_worth_diagnosing() {
        // The one case that earns a round of network probing.
        let before = [conn(&[])];
        let (verdict, detail) = classify(&before.iter().collect::<Vec<_>>(), &[], true);
        assert_eq!(verdict, Verdict::Abrupt);
        assert!(verdict.needs_diagnosis());
        assert!(detail.contains("ESTABLISHED"));
    }

    #[test]
    fn a_handshake_that_never_landed_is_not_a_drop() {
        let before = [conn(&[("state", "SYN sent")])];
        let (verdict, _) = classify(&before.iter().collect::<Vec<_>>(), &[], true);
        assert_eq!(verdict, Verdict::NeverConnected);
        assert!(!verdict.needs_diagnosis());
    }

    #[test]
    fn every_verdict_reads_as_a_sentence() {
        for v in [
            Verdict::ProcessExited,
            Verdict::LocalClosed,
            Verdict::RemoteClosed,
            Verdict::NeverConnected,
            Verdict::Abrupt,
        ] {
            assert!(!v.summary().is_empty());
        }
    }

    #[test]
    fn only_an_abrupt_drop_escalates() {
        // Guards the noise budget: everything else is a normal ending, and
        // pinging the gateway over it would make reports meaningless.
        let escalating: Vec<Verdict> = [
            Verdict::ProcessExited,
            Verdict::LocalClosed,
            Verdict::RemoteClosed,
            Verdict::NeverConnected,
            Verdict::Abrupt,
        ]
        .into_iter()
        .filter(|v| v.needs_diagnosis())
        .collect();
        assert_eq!(escalating, vec![Verdict::Abrupt]);
    }

    #[test]
    fn the_first_tick_never_announces_anything() {
        // A watch registered while its connection is already gone must not
        // report a drop that happened before anyone was looking.
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        assert!(w.tick(vec![], &running(&["chrome.exe"]), 0).is_empty());
    }

    #[test]
    fn a_steady_connection_produces_no_events() {
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        let procs = running(&["chrome.exe"]);

        w.tick(vec![conn(&[])], &procs, 0);
        assert!(w.tick(vec![conn(&[])], &procs, 1).is_empty());
        assert!(w.tick(vec![conn(&[])], &procs, 2).is_empty());
    }

    #[test]
    fn a_drop_is_announced_once_and_classified() {
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        let procs = running(&["chrome.exe"]);

        w.tick(vec![conn(&[])], &procs, 0);
        let events = w.tick(vec![], &procs, 1);

        assert_eq!(events.len(), 1);
        assert!(!events[0].up);
        assert_eq!(events[0].verdict, Some(Verdict::Abrupt));
        assert_eq!(events[0].label, spec().label);

        // Still down; nothing more to say about it.
        assert!(w.tick(vec![], &procs, 2).is_empty());
    }

    #[test]
    fn a_closing_socket_is_still_recognised_after_it_loses_its_owner() {
        // Found by watching a real connection close: Windows reports a
        // `Time wait` row against PID 0, so the watch's process filter stopped
        // matching its own remnant and every clean local close was reported as
        // an abrupt drop. Remnants are matched by five-tuple for this reason.
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        let procs = running(&["chrome.exe"]);

        w.tick(vec![conn(&[("id", "sock")])], &procs, 0);
        let orphaned = conn(&[("id", "sock"), ("state", "Time wait"), ("process", "-")]);
        let events = w.tick(vec![orphaned], &procs, 1);

        assert_eq!(
            events[0].verdict,
            Some(Verdict::LocalClosed),
            "an unattributed remnant should still be read as a clean close"
        );
    }

    #[test]
    fn remnants_are_matched_by_five_tuple_not_by_endpoint() {
        // Another process talking to the same peer is not evidence about this
        // connection's ending.
        let mine = conn(&[("id", "mine")]);
        let theirs = conn(&[("id", "theirs"), ("state", "Close wait")]);
        let before = [&mine];

        assert!(remnants(&before, &[theirs]).is_empty());
    }

    #[test]
    fn the_previous_snapshot_supplies_the_evidence() {
        // Time wait only appears *after* the transition, so classification has
        // to look at both sides of it.
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        let procs = running(&["chrome.exe"]);

        w.tick(vec![conn(&[])], &procs, 0);
        let events = w.tick(vec![conn(&[("state", "Time wait")])], &procs, 1);

        assert_eq!(events[0].verdict, Some(Verdict::LocalClosed));
    }

    #[test]
    fn a_vanished_process_is_reported_as_such() {
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);

        w.tick(vec![conn(&[])], &running(&["chrome.exe"]), 0);
        let events = w.tick(vec![], &running(&[]), 1);

        assert_eq!(events[0].verdict, Some(Verdict::ProcessExited));
    }

    #[test]
    fn recovery_is_announced_without_a_verdict() {
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        let procs = running(&["chrome.exe"]);

        w.tick(vec![conn(&[])], &procs, 0);
        w.tick(vec![], &procs, 1);
        let events = w.tick(vec![conn(&[])], &procs, 2);

        assert_eq!(events.len(), 1);
        assert!(events[0].up);
        assert_eq!(events[0].verdict, None);
    }

    #[test]
    fn a_pool_churning_underneath_is_not_a_drop() {
        // The reason endpoint watches exist. Every socket is replaced between
        // ticks and the conversation never stops.
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        let procs = running(&["chrome.exe"]);

        w.tick(vec![conn(&[("id", "a")]), conn(&[("id", "b")])], &procs, 0);
        let events = w.tick(vec![conn(&[("id", "c")]), conn(&[("id", "d")])], &procs, 1);

        assert!(events.is_empty(), "got {events:?}");
    }

    #[test]
    fn removing_a_watch_forgets_its_state() {
        // Re-adding it must start fresh, or it would inherit an up/down from a
        // previous life and announce a transition that never happened.
        let mut w = Watcher::new();
        w.set_specs(vec![spec()]);
        let procs = running(&["chrome.exe"]);

        w.tick(vec![conn(&[])], &procs, 0);
        w.set_specs(vec![]);
        w.set_specs(vec![spec()]);

        assert!(w.tick(vec![], &procs, 1).is_empty());
    }

    #[test]
    fn watches_are_independent() {
        let other = WatchSpec {
            id: "w2".into(),
            remote_addr: Some("8.8.8.8".into()),
            ..spec()
        };
        let mut w = Watcher::new();
        w.set_specs(vec![spec(), other]);
        let procs = running(&["chrome.exe"]);

        let both = vec![conn(&[]), conn(&[("remote", "8.8.8.8"), ("id", "z")])];
        w.tick(both, &procs, 0);

        // Only the second endpoint goes away.
        let events = w.tick(vec![conn(&[])], &procs, 1);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].watch_id, "w2");
    }

    #[test]
    fn watch_specs_round_trip_over_the_wire() {
        let s = spec();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("remoteAddr"), "expected camelCase: {json}");
        assert_eq!(serde_json::from_str::<WatchSpec>(&json).unwrap(), s);
    }
}
