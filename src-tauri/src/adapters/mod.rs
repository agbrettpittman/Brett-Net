//! Local network interface configuration.
//!
//! Answers "what is this machine's network actually set to" — address, gateway,
//! DNS servers — which is the first thing anyone checks when something is
//! wrong, and otherwise means reading `ipconfig /all` output.

use serde::Serialize;

#[cfg(windows)]
pub mod windows;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    /// What Windows shows in Network Connections, e.g. `Wi-Fi`.
    pub name: String,
    /// The hardware, e.g. `Intel(R) Wi-Fi 6E AX211 160MHz`.
    pub description: String,
    pub kind: String,
    pub status: String,
    /// `None` for interfaces with no hardware address, such as loopback.
    pub mac: Option<String>,
    /// `None` where the driver does not report one — loopback comes back as
    /// `u32::MAX`, which is not a 4 GB packet.
    pub mtu: Option<u32>,
    /// Link speed in bits per second, as reported by the driver.
    pub speed_bps: Option<u64>,
    /// Unicast addresses in CIDR form, e.g. `192.168.1.5/24`.
    pub addresses: Vec<String>,
    pub gateways: Vec<String>,
    pub dns: Vec<String>,
    /// The DHCP server that issued the lease, if there was one.
    pub dhcp_server: Option<String>,
    /// True when the interface is up *and* has a usable address — which is what
    /// "is this the one I am actually using" really means.
    pub active: bool,
}

/// `IF_TYPE_*` values worth naming. Everything else keeps its number, which is
/// more useful than calling it "Other".
///
/// <https://www.iana.org/assignments/ianaiftype-mib/ianaiftype-mib>
pub fn interface_kind(if_type: u32) -> String {
    match if_type {
        6 => "Ethernet".into(),
        23 => "PPP".into(),
        24 => "Loopback".into(),
        71 => "Wi-Fi".into(),
        131 => "Tunnel".into(),
        144 => "IEEE 1394".into(),
        237 => "IP over Infiniband".into(),
        other => format!("Type {other}"),
    }
}

/// `IF_OPER_STATUS`, which is a plain enum rather than a bitfield.
pub fn oper_status(status: i32) -> String {
    match status {
        1 => "Up".into(),
        2 => "Down".into(),
        3 => "Testing".into(),
        5 => "Dormant".into(),
        6 => "Not present".into(),
        7 => "Lower layer down".into(),
        // 4 is "Unknown", and so is anything else.
        _ => "Unknown".into(),
    }
}

/// Formats a hardware address as `AA-BB-CC-DD-EE-FF`.
///
/// Hyphens rather than colons, because that is what Windows shows everywhere
/// else and this is a Windows tool.
pub fn format_mac(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02X}")).collect();
    Some(hex.join("-"))
}

/// Lists the machine's network interfaces.
#[cfg(windows)]
pub fn list() -> Result<Vec<Adapter>, String> {
    windows::list()
}

/// Non-Windows builds exist only so the crate compiles for tooling.
#[cfg(not(windows))]
pub fn list() -> Result<Vec<Adapter>, String> {
    Err("adapter information is only available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_interface_types_that_matter() {
        assert_eq!(interface_kind(6), "Ethernet");
        assert_eq!(interface_kind(71), "Wi-Fi");
        assert_eq!(interface_kind(24), "Loopback");
        assert_eq!(interface_kind(131), "Tunnel");
    }

    #[test]
    fn keeps_the_number_for_an_unknown_type() {
        // More useful than "Other" — it can be looked up.
        assert_eq!(interface_kind(999), "Type 999");
    }

    #[test]
    fn maps_operational_status() {
        assert_eq!(oper_status(1), "Up");
        assert_eq!(oper_status(2), "Down");
        assert_eq!(oper_status(4), "Unknown");
        assert_eq!(oper_status(99), "Unknown");
    }

    #[test]
    fn formats_a_mac_address_the_windows_way() {
        assert_eq!(
            format_mac(&[0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E]).as_deref(),
            Some("00-1A-2B-3C-4D-5E")
        );
    }

    #[test]
    fn has_no_mac_when_there_is_no_hardware_address() {
        // Loopback and most tunnels have none.
        assert_eq!(format_mac(&[]), None);
    }

    #[test]
    fn formats_a_short_hardware_address() {
        // Not every interface has a six-byte address.
        assert_eq!(format_mac(&[0xAB, 0xCD]).as_deref(), Some("AB-CD"));
    }
}
