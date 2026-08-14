//! `GetExtendedTcpTable` from `iphlpapi.dll`, plus process names from a
//! Toolhelp snapshot.
//!
//! Names come from the snapshot rather than from opening each process by PID:
//! `OpenProcess` fails for anything owned by another user, so a third of the
//! table would come back nameless. The snapshot needs no privileges.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};

use windows::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

use super::{port_from_dword, tcp_state, Connection};

/// Enough for a few hundred connections in one call; grown on demand.
const INITIAL_BYTES: u32 = 32 * 1024;
/// The table can grow between the sizing call and the real one, so retry — but
/// not forever.
const MAX_ATTEMPTS: usize = 4;

/// The buffer is reinterpreted as a table struct, so it needs that struct's
/// alignment. A `Vec<u8>` is only 1-byte aligned, so casting one would be
/// undefined behaviour — the same trap that crashed the ICMP reply buffer with
/// `STATUS_STACK_BUFFER_OVERRUN`.
fn aligned_buffer(bytes: u32) -> Vec<u64> {
    vec![0u64; (bytes as usize).div_ceil(8).max(1)]
}

const _: () = assert!(
    align_of::<MIB_TCPTABLE_OWNER_PID>() <= align_of::<u64>()
        && align_of::<MIB_TCP6TABLE_OWNER_PID>() <= align_of::<u64>(),
    "buffer alignment must cover both table types"
);

pub fn list() -> Result<Vec<Connection>, String> {
    let names = process_names();
    let mut out = read_v4(&names)?;
    out.extend(read_v6(&names)?);
    Ok(out)
}

/// Fetches one address family's table into a correctly aligned buffer.
fn read_table(family: u32) -> Result<Vec<u64>, String> {
    let mut size = INITIAL_BYTES;

    for _ in 0..MAX_ATTEMPTS {
        let mut buf = aligned_buffer(size);

        // SAFETY: the pointer covers `size` bytes of aligned, zeroed storage,
        // and `size` is updated by the call.
        let ret = unsafe {
            GetExtendedTcpTable(
                Some(buf.as_mut_ptr().cast()),
                &mut size,
                false,
                family,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };

        if ret == ERROR_INSUFFICIENT_BUFFER.0 {
            // `size` now holds what is actually needed.
            continue;
        }
        if ret != NO_ERROR.0 {
            return Err(format!("GetExtendedTcpTable failed with code {ret}"));
        }
        return Ok(buf);
    }

    Err("the connection table kept growing while it was being read".into())
}

fn read_v4(names: &HashMap<u32, String>) -> Result<Vec<Connection>, String> {
    let buf = read_table(AF_INET.0 as u32)?;
    let table = buf.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();

    // SAFETY: the buffer is live and holds a table written by the call above.
    let header = unsafe { &*table };
    let rows = header.table.as_ptr();
    let mut out = Vec::with_capacity(header.dwNumEntries as usize);

    for i in 0..header.dwNumEntries as usize {
        // SAFETY: `table` is an anysize array of `dwNumEntries` rows.
        let row = unsafe { &*rows.add(i) };

        let local = Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes());
        let remote = Ipv4Addr::from(row.dwRemoteAddr.to_ne_bytes());
        let local_port = port_from_dword(row.dwLocalPort);
        let remote_port = port_from_dword(row.dwRemotePort);

        out.push(Connection {
            id: format!("{local}:{local_port}-{remote}:{remote_port}"),
            local_addr: local.to_string(),
            local_port,
            remote_addr: remote.to_string(),
            remote_port,
            state: tcp_state(row.dwState),
            pid: row.dwOwningPid,
            process: names.get(&row.dwOwningPid).cloned(),
            v6: false,
        });
    }

    Ok(out)
}

fn read_v6(names: &HashMap<u32, String>) -> Result<Vec<Connection>, String> {
    let buf = read_table(AF_INET6.0 as u32)?;
    let table = buf.as_ptr().cast::<MIB_TCP6TABLE_OWNER_PID>();

    // SAFETY: the buffer is live and holds a table written by the call above.
    let header = unsafe { &*table };
    let rows = header.table.as_ptr();
    let mut out = Vec::with_capacity(header.dwNumEntries as usize);

    for i in 0..header.dwNumEntries as usize {
        // SAFETY: `table` is an anysize array of `dwNumEntries` rows.
        let row = unsafe { &*rows.add(i) };

        let local = Ipv6Addr::from(row.ucLocalAddr);
        let remote = Ipv6Addr::from(row.ucRemoteAddr);
        let local_port = port_from_dword(row.dwLocalPort);
        let remote_port = port_from_dword(row.dwRemotePort);

        out.push(Connection {
            id: format!("[{local}]:{local_port}-[{remote}]:{remote_port}"),
            local_addr: local.to_string(),
            local_port,
            remote_addr: remote.to_string(),
            remote_port,
            state: tcp_state(row.dwState),
            pid: row.dwOwningPid,
            process: names.get(&row.dwOwningPid).cloned(),
            v6: true,
        });
    }

    Ok(out)
}

/// PID to executable name for every process this user can see.
///
/// A failure here is not fatal: an unnamed row is still a useful row, so this
/// returns an empty map rather than an error.
fn process_names() -> HashMap<u32, String> {
    let mut out = HashMap::new();

    // SAFETY: a snapshot handle is returned or the call fails; closed below.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return out;
    };

    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    // SAFETY: `entry` is correctly sized, and the handle is live.
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            out.insert(entry.th32ProcessID, exe_name(&entry.szExeFile));
            // SAFETY: same handle and entry, iterated per the API contract.
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }

    // SAFETY: the handle came from `CreateToolhelp32Snapshot` and is unused now.
    let _ = unsafe { CloseHandle(snapshot) };
    out
}

/// Reads a null-terminated wide string out of a fixed-size array.
///
/// The array is padded with whatever follows the terminator, so it must not be
/// read whole.
fn exe_name(chars: &[u16]) -> String {
    let len = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
    String::from_utf16_lossy(&chars[..len])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_buffer_is_big_enough_and_aligned() {
        let buf = aligned_buffer(INITIAL_BYTES);
        assert_eq!(buf.len() * 8, INITIAL_BYTES as usize);
        assert_eq!(
            buf.as_ptr() as usize % align_of::<MIB_TCPTABLE_OWNER_PID>(),
            0
        );
    }

    #[test]
    fn a_zero_size_still_allocates_something() {
        // Never hand the API a dangling pointer.
        assert!(!aligned_buffer(0).is_empty());
    }

    #[test]
    fn exe_names_stop_at_the_terminator() {
        let mut buf = [0u16; 16];
        for (i, c) in "chrome.exe".encode_utf16().enumerate() {
            buf[i] = c;
        }
        buf[12] = b'X' as u16; // junk past the terminator
        assert_eq!(exe_name(&buf), "chrome.exe");
    }

    #[test]
    fn process_names_finds_this_very_process() {
        let names = process_names();
        assert!(!names.is_empty(), "no processes enumerated at all");

        let me = std::process::id();
        assert!(
            names.contains_key(&me),
            "the test process ({me}) should be in its own snapshot"
        );
    }

    /// The real thing. Every Windows machine has open TCP connections.
    #[test]
    fn lists_the_real_connections() {
        let conns = list().expect("listing connections");
        assert!(!conns.is_empty(), "a running Windows box has TCP sockets");

        for c in &conns {
            assert!(!c.state.is_empty());
            assert!(!c.local_addr.is_empty());
            // A port that came back unswapped would be huge for well-known
            // services and is the single most likely bug in this file.
            assert!(c.local_port > 0 || c.state == "Closed");
        }

        // Something must be listening — Windows always has RPC and SMB up.
        assert!(
            conns.iter().any(|c| c.is_listener()),
            "no listeners found, which cannot be true on Windows"
        );
    }

    #[test]
    fn well_known_listeners_have_plausible_ports() {
        // Guards the byte-order conversion end to end: if it were wrong, every
        // system listener would land above 1024 rather than below it.
        let conns = list().expect("listing connections");
        let listeners: Vec<u16> = conns
            .iter()
            .filter(|c| c.is_listener())
            .map(|c| c.local_port)
            .collect();

        assert!(
            listeners.iter().any(|&p| p < 1024),
            "no privileged listener ports; byte order is probably wrong: {listeners:?}"
        );
    }

    #[test]
    fn connection_ids_are_unique() {
        // The five-tuple is the row key and later the watch handle, so a
        // collision would silently merge two connections.
        let conns = list().expect("listing connections");
        let ids: std::collections::HashSet<&String> = conns.iter().map(|c| &c.id).collect();
        assert_eq!(ids.len(), conns.len(), "duplicate connection ids");
    }

    #[test]
    fn most_connections_can_be_named() {
        // Not all — anything owned by another user stays anonymous, which is
        // expected rather than a failure.
        let conns = list().expect("listing connections");
        let named = conns.iter().filter(|c| c.process.is_some()).count();
        assert!(
            named * 2 > conns.len(),
            "only {named} of {} connections were named",
            conns.len()
        );
    }
}
