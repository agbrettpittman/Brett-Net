//! `GetIfTable2` from `iphlpapi.dll`.
//!
//! Unlike `GetAdaptersAddresses`, this one allocates its own table and hands
//! back a pointer, so there is no caller buffer to size or align — but it must
//! be released with `FreeMibTable` on every path out.

use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};

use super::{luid_key, InterfaceCounters};

pub fn counters() -> Result<Vec<InterfaceCounters>, String> {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();

    // SAFETY: `table` is a valid out-pointer; the allocation it receives is
    // freed below on every path.
    let ret = unsafe { GetIfTable2(&mut table) };
    if ret.is_err() {
        return Err(format!("GetIfTable2 failed with code {}", ret.0));
    }
    if table.is_null() {
        return Err("GetIfTable2 reported success but returned no table".into());
    }

    // SAFETY: the table is live until the `FreeMibTable` below, and `collect`
    // copies out owned values without retaining any pointer into it.
    let out = unsafe { collect(table) };
    // SAFETY: `table` came from `GetIfTable2` and is not used again.
    unsafe { FreeMibTable(table as *const core::ffi::c_void) };

    Ok(out)
}

/// Copies the counters out of the table.
///
/// # Safety
/// `table` must be a live table returned by `GetIfTable2`.
unsafe fn collect(table: *const MIB_IF_TABLE2) -> Vec<InterfaceCounters> {
    let header = unsafe { &*table };
    let rows = header.Table.as_ptr();
    let mut out = Vec::with_capacity(header.NumEntries as usize);

    for i in 0..header.NumEntries as usize {
        // SAFETY: `Table` is an anysize array of `NumEntries` rows.
        let row = unsafe { &*rows.add(i) };

        out.push(InterfaceCounters {
            // SAFETY: reading the union's integer view, which is always valid.
            luid: luid_key(unsafe { row.InterfaceLuid.Value }),
            name: fixed_wide_string(&row.Alias),
            in_octets: row.InOctets,
            out_octets: row.OutOctets,
        });
    }

    out
}

/// Reads a null-terminated wide string out of a fixed-size array.
///
/// `MIB_IF_ROW2` embeds its strings rather than pointing at them, so the array
/// is padded with whatever follows the terminator and must not be read whole.
fn fixed_wide_string(chars: &[u16]) -> String {
    let len = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..len])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_at_the_terminator_rather_than_reading_the_padding() {
        let mut buf = [0u16; 8];
        for (i, c) in "Wi-Fi".encode_utf16().enumerate() {
            buf[i] = c;
        }
        // Junk past the terminator, as a real fixed buffer would have.
        buf[6] = b'X' as u16;
        assert_eq!(fixed_wide_string(&buf), "Wi-Fi");
    }

    #[test]
    fn an_unterminated_buffer_is_read_whole_rather_than_overrunning() {
        let buf: Vec<u16> = "Ethernet".encode_utf16().collect();
        assert_eq!(fixed_wide_string(&buf), "Ethernet");
    }

    #[test]
    fn an_empty_name_is_empty() {
        assert_eq!(fixed_wide_string(&[0u16; 4]), "");
    }

    /// The real thing. Every machine has at least a loopback interface.
    #[test]
    fn reads_the_real_interface_counters() {
        let got = counters().expect("reading counters");
        assert!(!got.is_empty(), "every machine has at least loopback");

        for c in &got {
            assert_eq!(c.luid.len(), 16, "luid key should be fixed-width hex");
        }

        let keys: std::collections::HashSet<&String> = got.iter().map(|c| &c.luid).collect();
        assert_eq!(keys.len(), got.len(), "LUIDs must be unique per interface");

        // Something on this machine has received bytes, or the walk is wrong.
        assert!(
            got.iter().any(|c| c.in_octets > 0),
            "no interface has received anything: {:?}",
            got.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn counters_only_go_up_between_two_reads() {
        // Cumulative since boot. A decrease would mean the frontend's reset
        // detection is load-bearing far more often than expected.
        let first = counters().expect("first read");
        let second = counters().expect("second read");

        for a in &first {
            let Some(b) = second.iter().find(|b| b.luid == a.luid) else {
                continue;
            };
            assert!(b.in_octets >= a.in_octets, "{} went backwards", a.name);
            assert!(b.out_octets >= a.out_octets, "{} went backwards", a.name);
        }
    }
}
