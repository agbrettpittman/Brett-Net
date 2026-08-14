//! Keeping the machine awake on request.
//!
//! Windows tracks this per *thread*: the state belongs to whichever thread
//! called `SetThreadExecutionState`, and is dropped the moment that thread
//! exits. A Tauri command runs on a pool thread that may be gone seconds later,
//! so calling it from one would appear to work and then quietly stop working.
//!
//! Hence the dedicated thread below. It is the only thing that ever touches the
//! API, and it lives for the whole process.

use std::sync::mpsc::{self, Sender, SyncSender};

#[cfg(windows)]
pub mod windows;

struct Request {
    on: bool,
    /// Carries the previous execution state back to the caller.
    reply: SyncSender<u32>,
}

pub struct KeepAwake {
    tx: Sender<Request>,
}

impl KeepAwake {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<Request>();

        std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                while let Ok(req) = rx.recv() {
                    let _ = req.reply.send(apply(req.on));
                }
                // The sender is gone, so the app is shutting down. Releasing is
                // belt and braces — the state dies with the process anyway.
                apply(false);
            })
            .expect("spawning the keep-awake thread");

        Self { tx }
    }

    /// Requests or releases the wake lock.
    ///
    /// Returns the *previous* execution state. That return value is the only
    /// way to observe that the request actually landed — there is no API to ask
    /// Windows what the current thread's state is — so it is carried back
    /// rather than discarded.
    pub fn set(&self, on: bool) -> Result<u32, String> {
        let (reply, wait) = mpsc::sync_channel(0);
        self.tx
            .send(Request { on, reply })
            .map_err(|_| "the keep-awake thread is gone".to_string())?;
        wait.recv()
            .map_err(|_| "the keep-awake thread stopped answering".to_string())
    }
}

impl Default for KeepAwake {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
fn apply(on: bool) -> u32 {
    windows::apply(on)
}

/// Non-Windows builds exist only so the crate compiles for tooling.
#[cfg(not(windows))]
fn apply(_on: bool) -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_and_clearing_both_answer() {
        let awake = KeepAwake::new();
        assert!(awake.set(true).is_ok());
        assert!(awake.set(false).is_ok());
    }

    #[test]
    fn repeated_requests_are_harmless() {
        // The UI can send the same value twice — a click while already on, or a
        // release on shutdown after one on close.
        let awake = KeepAwake::new();
        for on in [true, true, false, false] {
            assert!(awake.set(on).is_ok(), "set({on}) failed");
        }
    }
}
