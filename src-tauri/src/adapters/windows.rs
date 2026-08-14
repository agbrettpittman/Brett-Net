//! `GetAdaptersAddresses` from `iphlpapi.dll`.
//!
//! The API hands back a singly linked list threaded through one caller-supplied
//! buffer, so every pointer in it is only valid while that buffer lives. All the
//! walking therefore happens inside [`list`], which copies out owned values.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
    GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows::Win32::Networking::WinSock::{
    AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6, SOCKET_ADDRESS,
};

use super::{format_mac, interface_kind, oper_status, Adapter};

/// Microsoft's recommended starting size; almost always enough in one call.
const INITIAL_BYTES: u32 = 15 * 1024;
/// The list can grow between the sizing call and the real one, so retry — but
/// not forever.
const MAX_ATTEMPTS: usize = 4;

/// The buffer is reinterpreted as `IP_ADAPTER_ADDRESSES_LH`, which is full of
/// pointers and therefore needs pointer alignment. A `Vec<u8>` is only 1-byte
/// aligned, so casting one would be undefined behaviour — the same trap that
/// crashed the ICMP reply buffer with `STATUS_STACK_BUFFER_OVERRUN`.
fn aligned_buffer(bytes: u32) -> Vec<u64> {
    vec![0u64; (bytes as usize).div_ceil(8).max(1)]
}

const _: () = assert!(
    align_of::<IP_ADAPTER_ADDRESSES_LH>() <= align_of::<u64>(),
    "buffer alignment must cover IP_ADAPTER_ADDRESSES_LH"
);

pub fn list() -> Result<Vec<Adapter>, String> {
    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
    let mut size = INITIAL_BYTES;

    for _ in 0..MAX_ATTEMPTS {
        let mut buf = aligned_buffer(size);
        let head = buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();

        // SAFETY: `head` points at `size` bytes of correctly aligned, zeroed
        // storage, and `size` is updated by the call.
        let ret =
            unsafe { GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(head), &mut size) };

        if ret == ERROR_BUFFER_OVERFLOW.0 {
            // `size` now holds what is actually needed.
            continue;
        }
        if ret != ERROR_SUCCESS.0 && ret != NO_ERROR.0 {
            return Err(format!("GetAdaptersAddresses failed with code {ret}"));
        }

        // SAFETY: the walk stays inside this scope, so `buf` outlives every
        // pointer read from it.
        return Ok(unsafe { collect(head) });
    }

    Err("the adapter list kept growing while it was being read".into())
}

/// Walks the linked list, copying everything out.
///
/// # Safety
/// `head` must be a list returned by `GetAdaptersAddresses` whose backing
/// buffer is still alive.
unsafe fn collect(head: *const IP_ADAPTER_ADDRESSES_LH) -> Vec<Adapter> {
    let mut out = Vec::new();
    let mut node = head;

    while !node.is_null() {
        let a = unsafe { &*node };

        let mac = format_mac(&a.PhysicalAddress[..a.PhysicalAddressLength as usize]);
        let status = oper_status(a.OperStatus.0);
        let addresses = unsafe { unicast_addresses(a) };

        out.push(Adapter {
            // SAFETY: reading the union's integer view, which is always valid.
            luid: crate::traffic::luid_key(unsafe { a.Luid.Value }),
            name: unsafe { wide_string(a.FriendlyName.0) },
            description: unsafe { wide_string(a.Description.0) },
            kind: interface_kind(a.IfType),
            // Up, and actually configured. An adapter can be up with nothing on
            // it, which is not the one you are using.
            active: status == "Up" && !addresses.is_empty(),
            status,
            mac,
            // Loopback reports u32::MAX, which is a sentinel and not a 4 GB
            // packet — printing it verbatim looked like a parsing bug.
            mtu: match a.Mtu {
                0 | u32::MAX => None,
                m => Some(m),
            },
            // Drivers report 0 or u64::MAX when they do not know.
            speed_bps: match a.TransmitLinkSpeed {
                0 | u64::MAX => None,
                bps => Some(bps),
            },
            addresses,
            gateways: unsafe { gateway_addresses(a) },
            dns: unsafe { dns_addresses(a) },
            dhcp_server: unsafe { socket_address(&a.Dhcpv4Server) }
                // An all-zero server means no lease, not a server at 0.0.0.0.
                .filter(|ip| !ip.is_unspecified())
                .map(|ip| ip.to_string()),
        });

        node = a.Next;
    }

    out
}

/// # Safety
/// `a` must be a live node.
unsafe fn unicast_addresses(a: &IP_ADAPTER_ADDRESSES_LH) -> Vec<String> {
    let mut out = Vec::new();
    let mut node = a.FirstUnicastAddress;

    while !node.is_null() {
        let entry = unsafe { &*node };
        if let Some(ip) = unsafe { socket_address(&entry.Address) } {
            // CIDR, because an address without its prefix does not tell you
            // what the machine considers local.
            out.push(format!("{ip}/{}", entry.OnLinkPrefixLength));
        }
        node = entry.Next;
    }

    out
}

/// # Safety
/// `a` must be a live node.
unsafe fn gateway_addresses(a: &IP_ADAPTER_ADDRESSES_LH) -> Vec<String> {
    let mut out = Vec::new();
    let mut node = a.FirstGatewayAddress;

    while !node.is_null() {
        let entry = unsafe { &*node };
        if let Some(ip) = unsafe { socket_address(&entry.Address) } {
            out.push(ip.to_string());
        }
        node = entry.Next;
    }

    out
}

/// # Safety
/// `a` must be a live node.
unsafe fn dns_addresses(a: &IP_ADAPTER_ADDRESSES_LH) -> Vec<String> {
    let mut out = Vec::new();
    let mut node = a.FirstDnsServerAddress;

    while !node.is_null() {
        let entry = unsafe { &*node };
        if let Some(ip) = unsafe { socket_address(&entry.Address) } {
            out.push(ip.to_string());
        }
        node = entry.Next;
    }

    out
}

/// Reads a `SOCKET_ADDRESS` as an IP address.
///
/// # Safety
/// `addr.lpSockaddr`, if non-null, must point at a valid sockaddr of at least
/// `iSockaddrLength` bytes.
unsafe fn socket_address(addr: &SOCKET_ADDRESS) -> Option<IpAddr> {
    let sa: *const SOCKADDR = addr.lpSockaddr;
    if sa.is_null() {
        return None;
    }

    match unsafe { (*sa).sa_family } {
        AF_INET => {
            let v4 = unsafe { &*(sa as *const SOCKADDR_IN) };
            // `S_un.S_addr` is already in network byte order, which is the
            // order `Ipv4Addr::from(u32)` expects big-endian bytes in.
            let octets = unsafe { v4.sin_addr.S_un.S_addr }.to_ne_bytes();
            Some(IpAddr::V4(Ipv4Addr::from(octets)))
        }
        AF_INET6 => {
            let v6 = unsafe { &*(sa as *const SOCKADDR_IN6) };
            let octets = unsafe { v6.sin6_addr.u.Byte };
            Some(IpAddr::V6(Ipv6Addr::from(octets)))
        }
        _ => None,
    }
}

/// Copies a null-terminated wide string.
///
/// # Safety
/// `ptr`, if non-null, must point at a null-terminated UTF-16 string.
unsafe fn wide_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0;
    // SAFETY: the caller guarantees a terminator, so this stops.
    while unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_buffer_is_big_enough_and_aligned() {
        let buf = aligned_buffer(15 * 1024);
        assert_eq!(buf.len() * 8, 15 * 1024);
        assert_eq!(
            buf.as_ptr() as usize % align_of::<IP_ADAPTER_ADDRESSES_LH>(),
            0
        );
    }

    #[test]
    fn a_zero_size_still_allocates_something() {
        // Never hand the API a dangling pointer.
        assert!(!aligned_buffer(0).is_empty());
    }

    #[test]
    fn rounds_a_partial_word_up() {
        assert_eq!(aligned_buffer(9).len(), 2);
    }

    /// The real thing. Every machine has at least a loopback interface, so this
    /// is safe to run anywhere.
    #[test]
    fn lists_the_real_adapters() {
        let adapters = list().expect("listing adapters");
        assert!(!adapters.is_empty(), "every machine has at least loopback");

        for a in &adapters {
            assert!(!a.description.is_empty(), "adapter with no description");
            assert!(!a.status.is_empty());
            assert!(!a.kind.is_empty());
        }

        // Loopback is always present and always up.
        let loopback = adapters.iter().find(|a| a.kind == "Loopback");
        assert!(loopback.is_some(), "no loopback in {:?}", names(&adapters));

        // Whatever is carrying this machine's traffic must have an address and
        // a gateway; if nothing does, the walk is reading the list wrong.
        assert!(
            adapters.iter().any(|a| a.active && !a.gateways.is_empty()),
            "no active adapter with a gateway: {:?}",
            names(&adapters)
        );
    }

    #[test]
    fn addresses_come_back_in_cidr_form() {
        let adapters = list().expect("listing adapters");
        let all: Vec<&String> = adapters.iter().flat_map(|a| &a.addresses).collect();
        assert!(!all.is_empty());

        for addr in all {
            let (ip, prefix) = addr.rsplit_once('/').expect("missing prefix length");
            assert!(ip.parse::<IpAddr>().is_ok(), "bad address {addr}");
            let bits: u8 = prefix.parse().expect("bad prefix length");
            assert!(bits <= 128, "impossible prefix in {addr}");
        }
    }

    #[test]
    fn loopback_is_present_and_has_no_hardware_address() {
        let adapters = list().expect("listing adapters");
        let lo = adapters
            .iter()
            .find(|a| a.kind == "Loopback")
            .expect("loopback");

        assert_eq!(lo.mac, None);
        assert!(
            lo.addresses.iter().any(|a| a.starts_with("127.")),
            "loopback without 127.x: {:?}",
            lo.addresses
        );
    }

    fn names(adapters: &[Adapter]) -> Vec<&str> {
        adapters.iter().map(|a| a.name.as_str()).collect()
    }
}
