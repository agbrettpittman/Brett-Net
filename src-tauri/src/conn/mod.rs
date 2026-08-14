//! Open TCP connections, and which process owns each one.
//!
//! Answers "what is this machine actually talking to", which neither the ping
//! graph nor the adapter list can — they show the paths, not the conversations.

use serde::Serialize;

#[cfg(windows)]
pub mod windows;

pub mod watch;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// The five-tuple, which is unique by definition — no two connections can
    /// share one. Used as the row key, and later as the handle for watching.
    pub id: String,
    pub local_addr: String,
    pub local_port: u16,
    /// `0.0.0.0` / `::` with port 0 for a listener, which has no peer yet.
    pub remote_addr: String,
    pub remote_port: u16,
    pub state: String,
    pub pid: u32,
    /// `None` when the owning process could not be named — normally one running
    /// as another user, which needs privileges this app deliberately lacks.
    pub process: Option<String>,
    pub v6: bool,
}

impl Connection {
    /// True for a socket waiting for inbound connections rather than talking to
    /// a peer.
    pub fn is_listener(&self) -> bool {
        self.state == "Listen"
    }
}

/// `MIB_TCP_STATE`, which is a plain enum rather than a bitfield.
///
/// The names are the ones every other network tool prints, so they can be
/// searched for and compared against `netstat` output directly.
pub fn tcp_state(state: u32) -> String {
    match state {
        1 => "Closed".into(),
        2 => "Listen".into(),
        3 => "SYN sent".into(),
        4 => "SYN received".into(),
        5 => "Established".into(),
        6 => "FIN wait 1".into(),
        7 => "FIN wait 2".into(),
        8 => "Close wait".into(),
        9 => "Closing".into(),
        10 => "Last ACK".into(),
        11 => "Time wait".into(),
        12 => "Delete TCB".into(),
        other => format!("State {other}"),
    }
}

/// Reads a port out of the `DWORD` the table stores it in.
///
/// **The value is in network byte order inside the low 16 bits.** Reading it
/// as a plain number gives 20480 for port 80, which looks like a plausible
/// ephemeral port and is the reason this has its own function and its own test.
pub fn port_from_dword(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}

/// Lists every TCP connection, IPv4 and IPv6.
#[cfg(windows)]
pub fn list() -> Result<Vec<Connection>, String> {
    windows::list()
}

/// Executable names of every running process, lower-cased.
///
/// Used to tell "the connection died" from "the application closed", which is
/// the difference between a network fault and nothing at all.
#[cfg(windows)]
pub fn running_processes() -> std::collections::HashSet<String> {
    windows::process_names()
        .into_values()
        .map(|n| n.to_ascii_lowercase())
        .collect()
}

/// Non-Windows builds exist only so the crate compiles for tooling.
#[cfg(not(windows))]
pub fn list() -> Result<Vec<Connection>, String> {
    Err("connection information is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn running_processes() -> std::collections::HashSet<String> {
    std::collections::HashSet::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_states_netstat_prints() {
        assert_eq!(tcp_state(2), "Listen");
        assert_eq!(tcp_state(5), "Established");
        assert_eq!(tcp_state(8), "Close wait");
        assert_eq!(tcp_state(11), "Time wait");
    }

    #[test]
    fn keeps_the_number_for_an_unknown_state() {
        // More useful than "Unknown" — it can be looked up.
        assert_eq!(tcp_state(99), "State 99");
    }

    #[test]
    fn ports_come_out_of_network_byte_order() {
        // 80 stored big-endian in the low half is 0x5000 read as a number.
        assert_eq!(port_from_dword(0x5000), 80);
        assert_eq!(port_from_dword(0xBB01), 443);
        assert_eq!(port_from_dword(0), 0);
    }

    #[test]
    fn the_high_half_of_the_dword_is_ignored() {
        // Windows leaves whatever it likes up there; only the low 16 bits are
        // the port.
        assert_eq!(port_from_dword(0xDEAD_5000), 80);
    }

    #[test]
    fn a_listener_is_recognised_by_its_state() {
        let c = Connection {
            id: "x".into(),
            local_addr: "0.0.0.0".into(),
            local_port: 445,
            remote_addr: "0.0.0.0".into(),
            remote_port: 0,
            state: tcp_state(2),
            pid: 4,
            process: None,
            v6: false,
        };
        assert!(c.is_listener());
    }
}
