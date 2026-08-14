//! `SetThreadExecutionState` from `kernel32.dll`.

use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

/// Requests or releases the wake lock, returning the previous state.
///
/// `ES_CONTINUOUS` is what makes the request *stick* rather than counting as a
/// single "something happened just now" nudge; without it the flags reset the
/// idle timer once and are immediately forgotten.
///
/// Deliberately **not** `ES_DISPLAY_REQUIRED`. Stopping the machine sleeping is
/// the point; forcing the screen to stay lit for a download that runs for an
/// hour would burn the panel for no benefit, and the display turning off does
/// not interrupt anything.
pub fn apply(on: bool) -> u32 {
    let flags = if on {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };

    // SAFETY: no pointers involved; the call only sets thread-local state.
    unsafe { SetThreadExecutionState(flags) }.0
}

#[cfg(test)]
mod tests {
    use super::super::KeepAwake;
    use super::*;

    #[test]
    fn the_request_shows_up_in_the_next_calls_previous_state() {
        // The real verification. Windows offers no way to query the current
        // thread's execution state, but every call returns the state it
        // replaced — so asking it to release and finding ES_SYSTEM_REQUIRED in
        // the answer proves the request had genuinely been in force.
        let awake = KeepAwake::new();

        awake.set(true).expect("requesting the wake lock");
        let previous = awake.set(false).expect("releasing the wake lock");

        assert!(
            previous & ES_SYSTEM_REQUIRED.0 != 0,
            "expected ES_SYSTEM_REQUIRED in the previous state, got {previous:#x}"
        );
    }

    #[test]
    fn releasing_leaves_the_request_behind() {
        let awake = KeepAwake::new();

        awake.set(true).unwrap();
        awake.set(false).unwrap();
        // A second release should now report a state without the request in it.
        let previous = awake.set(false).unwrap();

        assert_eq!(
            previous & ES_SYSTEM_REQUIRED.0,
            0,
            "the wake lock outlived its release: {previous:#x}"
        );
    }
}
