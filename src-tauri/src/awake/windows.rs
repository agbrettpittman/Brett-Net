//! `SetThreadExecutionState`, plus the input nudge that stops the session
//! going idle.

use std::time::Duration;

use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetLastInputInfo, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, LASTINPUTINFO, VIRTUAL_KEY,
};

/// F15. Windows defines virtual codes for F13–F24, but no keyboard has shipped
/// them in decades, so essentially nothing is bound to one — and it produces no
/// character, so it cannot type into whatever happens to be focused.
const VK_F15: VIRTUAL_KEY = VIRTUAL_KEY(0x7E);

/// Requests or releases the wake lock, returning the previous state.
///
/// `ES_CONTINUOUS` is what makes the request *stick* rather than counting as a
/// single "something happened just now" nudge; without it the flags reset the
/// idle timer once and are immediately forgotten.
///
/// Deliberately **not** `ES_DISPLAY_REQUIRED`. Stopping the machine sleeping is
/// the point; forcing the screen to stay lit for a transfer that runs for hours
/// would burn the panel for no benefit, and the display switching off does not
/// interrupt anything.
pub fn apply(on: bool) -> u32 {
    let flags = if on {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };

    // SAFETY: no pointers involved; the call only sets thread-local state.
    unsafe { SetThreadExecutionState(flags) }.0
}

/// How long since the last real user input.
pub fn idle() -> Duration {
    let mut info = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };

    // SAFETY: `info` is a correctly sized, initialised struct.
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        // Both are tick counts, which wrap every ~49.7 days. Wrapping
        // subtraction gives the right answer across the boundary; a plain one
        // would report a machine idle for weeks.
        let elapsed = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
        Duration::from_millis(elapsed as u64)
    } else {
        Duration::ZERO
    }
}

/// Sends one harmless keystroke, but only if the session has been idle at least
/// `threshold`.
///
/// The guard is the whole reason this is unobtrusive: while someone is typing
/// or moving the mouse the idle counter never reaches the threshold, so nothing
/// is ever injected into what they are doing.
///
/// Returns whether a key was actually sent.
pub fn nudge_if_idle(threshold: Duration) -> bool {
    if idle() < threshold {
        return false;
    }

    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_F15,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let events = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];

    // SAFETY: `events` is a valid slice of correctly initialised INPUT values,
    // and the size argument matches the type it is describing.
    unsafe { SendInput(&events, size_of::<INPUT>() as i32) };
    true
}

#[cfg(test)]
mod tests {
    use super::super::{KeepAwake, Mode};
    use super::*;

    #[test]
    fn the_request_shows_up_in_the_next_calls_previous_state() {
        // The real verification. Windows offers no way to query the current
        // thread's execution state, but every call returns the state it
        // replaced — so asking it to release and finding ES_SYSTEM_REQUIRED in
        // the answer proves the request had genuinely been in force.
        let awake = KeepAwake::new(|| {});

        awake.set(Mode::Awake, 0).expect("requesting the wake lock");
        let previous = awake.set(Mode::Off, 0).expect("releasing the wake lock");

        assert!(
            previous & ES_SYSTEM_REQUIRED.0 != 0,
            "expected ES_SYSTEM_REQUIRED in the previous state, got {previous:#x}"
        );
    }

    #[test]
    fn releasing_leaves_the_request_behind() {
        let awake = KeepAwake::new(|| {});

        awake.set(Mode::Awake, 0).unwrap();
        awake.set(Mode::Off, 0).unwrap();
        let previous = awake.set(Mode::Off, 0).unwrap();

        assert_eq!(
            previous & ES_SYSTEM_REQUIRED.0,
            0,
            "the wake lock outlived its release: {previous:#x}"
        );
    }

    #[test]
    fn a_nudge_resets_the_windows_idle_timer() {
        // The real verification for the nudge: the injected key is ordinary
        // input as far as Windows is concerned, so the system-wide idle counter
        // — the very thing a lock policy watches — must come back near zero.
        assert!(
            nudge_if_idle(Duration::ZERO),
            "a zero threshold should always nudge"
        );
        let after = idle();
        assert!(
            after < Duration::from_secs(2),
            "idle was still {after:?} after a nudge"
        );
    }

    #[test]
    fn a_threshold_that_has_not_been_reached_suppresses_the_nudge() {
        // Reset the counter, then ask for a threshold it cannot possibly have
        // crossed. This is what keeps it out of the way while someone is
        // actually using the machine.
        nudge_if_idle(Duration::ZERO);
        assert!(!nudge_if_idle(Duration::from_secs(3600)));
    }
}
