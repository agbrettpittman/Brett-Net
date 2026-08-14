//! Keeping the machine awake, and optionally keeping the session active.
//!
//! Windows tracks the sleep request per *thread*: the state belongs to whichever
//! thread called `SetThreadExecutionState`, and is dropped the moment that
//! thread exits. A Tauri command runs on a pool thread that may be gone seconds
//! later, so calling it from one would appear to work and then quietly stop.
//!
//! Hence the dedicated thread below. It is the only thing that touches the API,
//! it lives for the whole process, and it doubles as the timer for both the
//! expiry deadline and the idle nudge.

use std::sync::mpsc::{self, RecvTimeoutError, Sender, SyncSender};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
pub mod windows;

/// How often the thread wakes to check the deadline and the idle timer.
#[cfg(not(test))]
const TICK: Duration = Duration::from_secs(15);

/// Shortened under test. The deadline and nudge logic are cadence-independent —
/// they compare against wall-clock instants either way — and the real fifteen
/// seconds would add most of a minute to every run of the whole suite.
#[cfg(test)]
const TICK: Duration = Duration::from_millis(200);

/// How long the session must have been idle before a nudge is sent.
///
/// Low enough to beat a one-minute lock policy, high enough that it never fires
/// while someone is actually using the machine — the moment real input arrives,
/// the counter resets and the nudge is suppressed again.
const IDLE_BEFORE_NUDGE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Off,
    /// Block sleep. The screen may still switch off and the session may lock.
    Awake,
    /// Block sleep *and* keep the session from going idle, which is what stops
    /// it locking.
    Active,
}

impl Mode {
    fn holds_wake_lock(self) -> bool {
        self != Mode::Off
    }
}

struct Request {
    mode: Mode,
    /// Seconds until the request releases itself. `0` means no limit.
    seconds: u64,
    /// Carries the previous execution state back to the caller.
    reply: SyncSender<u32>,
}

pub struct KeepAwake {
    tx: Sender<Request>,
}

impl KeepAwake {
    /// `on_expire` is called from the worker thread when a timed request runs
    /// out, so the UI can drop back to Off without polling for it.
    pub fn new<F>(on_expire: F) -> Self
    where
        F: Fn() + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Request>();

        std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                let mut mode = Mode::Off;
                let mut deadline: Option<Instant> = None;

                loop {
                    match rx.recv_timeout(TICK) {
                        Ok(req) => {
                            mode = req.mode;
                            deadline = (req.seconds > 0 && mode.holds_wake_lock())
                                .then(|| Instant::now() + Duration::from_secs(req.seconds));
                            let _ = req.reply.send(apply(mode.holds_wake_lock()));
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            if deadline.is_some_and(|at| Instant::now() >= at) {
                                mode = Mode::Off;
                                deadline = None;
                                apply(false);
                                on_expire();
                                continue;
                            }
                            if mode == Mode::Active {
                                nudge(IDLE_BEFORE_NUDGE);
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }

                // The sender is gone, so the app is shutting down. Releasing is
                // belt and braces — the state dies with the process anyway.
                apply(false);
            })
            .expect("spawning the keep-awake thread");

        Self { tx }
    }

    /// Applies a mode, optionally for a limited time.
    ///
    /// Returns the *previous* execution state. That return value is the only
    /// way to observe that the request landed — there is no API to ask Windows
    /// what the current thread's state is — so it is carried back rather than
    /// discarded.
    pub fn set(&self, mode: Mode, seconds: u64) -> Result<u32, String> {
        let (reply, wait) = mpsc::sync_channel(0);
        self.tx
            .send(Request {
                mode,
                seconds,
                reply,
            })
            .map_err(|_| "the keep-awake thread is gone".to_string())?;
        wait.recv()
            .map_err(|_| "the keep-awake thread stopped answering".to_string())
    }
}

#[cfg(windows)]
fn apply(on: bool) -> u32 {
    windows::apply(on)
}

#[cfg(windows)]
fn nudge(threshold: Duration) -> bool {
    windows::nudge_if_idle(threshold)
}

/// Non-Windows builds exist only so the crate compiles for tooling.
#[cfg(not(windows))]
fn apply(_on: bool) -> u32 {
    0
}

#[cfg(not(windows))]
fn nudge(_threshold: Duration) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn quiet() -> KeepAwake {
        KeepAwake::new(|| {})
    }

    #[test]
    fn every_mode_answers() {
        let awake = quiet();
        for mode in [Mode::Awake, Mode::Active, Mode::Off] {
            assert!(awake.set(mode, 0).is_ok(), "set({mode:?}) failed");
        }
    }

    #[test]
    fn repeated_requests_are_harmless() {
        // The UI can send the same value twice — a click while already on, or a
        // release on close after one on unmount.
        let awake = quiet();
        for mode in [Mode::Awake, Mode::Awake, Mode::Off, Mode::Off] {
            assert!(awake.set(mode, 0).is_ok());
        }
    }

    #[test]
    fn a_timed_request_releases_itself() {
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&fired);
        let awake = KeepAwake::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });

        // Already past by the time the first tick lands.
        awake.set(Mode::Awake, 1).unwrap();
        std::thread::sleep(Duration::from_millis(1400));

        assert_eq!(
            fired.load(Ordering::SeqCst),
            1,
            "the deadline should have fired exactly once"
        );
    }

    #[test]
    fn no_limit_never_expires() {
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&fired);
        let awake = KeepAwake::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });

        awake.set(Mode::Awake, 0).unwrap();
        std::thread::sleep(Duration::from_millis(1400));

        assert_eq!(fired.load(Ordering::SeqCst), 0, "0 seconds means no limit");
    }

    #[test]
    fn turning_off_cancels_a_pending_deadline() {
        // Otherwise a stale deadline would fire later and emit a spurious
        // "expired" at a UI that had already moved on.
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&fired);
        let awake = KeepAwake::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });

        awake.set(Mode::Awake, 1).unwrap();
        awake.set(Mode::Off, 0).unwrap();
        std::thread::sleep(Duration::from_millis(1400));

        assert_eq!(fired.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn modes_round_trip_over_the_wire() {
        assert_eq!(serde_json::to_string(&Mode::Active).unwrap(), "\"active\"");
        assert_eq!(serde_json::from_str::<Mode>("\"off\"").unwrap(), Mode::Off);
    }
}
