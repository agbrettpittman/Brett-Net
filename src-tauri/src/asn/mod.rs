//! IP → ASN lookup, so a traceroute names the networks it crosses.
//!
//! Uses Team Cymru's whois service, which is the same source most traceroute
//! tools use. Plain TCP on port 43 needs no HTTP client, no API key, and no
//! extra dependency, and its bulk mode answers every hop in one round trip
//! rather than one per address.
//!
//! Two rules this module exists to enforce:
//!
//! 1. **Only public addresses are ever sent.** Private, loopback, link-local and
//!    carrier-grade NAT hops stay on this machine. On a corporate network the
//!    internal ones are exactly the addresses that must not leave it, and CGNAT
//!    in particular looks routable but is not — real traces are full of
//!    `100.64/10`.
//! 2. **Failure is not an error.** Port 43 may well be blocked. A trace without
//!    ASN names is still a useful trace, so lookups degrade to nothing.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

const SERVER: &str = "whois.cymru.com:43";
const TIMEOUT: Duration = Duration::from_secs(6);
/// Guards against a misbehaving server filling memory.
const MAX_RESPONSE: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsnInfo {
    pub ip: String,
    /// `None` for an address that is not announced in BGP.
    pub asn: Option<u32>,
    /// Network operator, e.g. `CLOUDFLARENET`.
    pub name: Option<String>,
    /// Announced prefix, e.g. `1.1.1.0/24`.
    pub prefix: Option<String>,
    /// Two-letter country code.
    pub country: Option<String>,
}

/// Whether an address is on the public internet, and so safe to look up.
///
/// Deliberately hand-written: `Ipv4Addr::is_global` is still unstable, and the
/// stable helpers between them miss carrier-grade NAT, which is the range most
/// likely to show up mid-trace and be mistaken for a routable address.
pub fn is_public(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();

    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        // 0.0.0.0/8 — "this network".
        || a == 0
        // 100.64.0.0/10 — carrier-grade NAT (RFC 6598).
        || (a == 100 && (64..128).contains(&b))
        // 192.0.0.0/24 — IETF protocol assignments.
        || (a == 192 && b == 0 && ip.octets()[2] == 0)
        // 198.18.0.0/15 — benchmarking (RFC 2544).
        || (a == 198 && (b == 18 || b == 19))
        // 240.0.0.0/4 — reserved.
        || a >= 240)
}

/// Builds a Team Cymru bulk-mode query.
pub fn build_query(ips: &[Ipv4Addr]) -> String {
    let mut q = String::from("begin\nverbose\n");
    for ip in ips {
        q.push_str(&ip.to_string());
        q.push('\n');
    }
    q.push_str("end\n");
    q
}

/// Strips the country code Team Cymru appends to the operator name.
///
/// The field comes back as `CLOUDFLARENET, US`, and the country already has its
/// own column. Only an exact two-letter uppercase suffix is removed, so a name
/// genuinely ending in something like `, Inc` survives.
fn clean_name(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "NA" {
        return None;
    }
    let cleaned = match raw.rsplit_once(", ") {
        Some((head, tail)) if tail.len() == 2 && tail.chars().all(|c| c.is_ascii_uppercase()) => {
            head
        }
        _ => raw,
    };
    Some(cleaned.trim().to_string())
}

fn field(parts: &[&str], i: usize) -> Option<String> {
    let v = parts.get(i)?.trim();
    if v.is_empty() || v == "NA" {
        None
    } else {
        Some(v.to_string())
    }
}

/// Parses a bulk-mode response.
///
/// Lines that are not `AS | IP | prefix | CC | registry | allocated | name` are
/// skipped, which covers the banner and anything unexpected.
pub fn parse_response(body: &str) -> Vec<AsnInfo> {
    let mut out = Vec::new();

    for line in body.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 7 {
            continue;
        }
        // The second column must be the address we asked about; this is what
        // rejects the banner line without matching on its text.
        let Ok(ip) = parts[1].trim().parse::<Ipv4Addr>() else {
            continue;
        };

        out.push(AsnInfo {
            ip: ip.to_string(),
            asn: parts[0].trim().parse::<u32>().ok(),
            name: parts.get(6).and_then(|n| clean_name(n)),
            prefix: field(&parts, 2),
            country: field(&parts, 3),
        });
    }

    out
}

/// Queries the whois service. Blocks, so callers run it off the async runtime.
fn query(ips: &[Ipv4Addr]) -> Result<String, String> {
    let addr = SERVER
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve {SERVER}: {e}"))?
        .next()
        .ok_or_else(|| format!("no address for {SERVER}"))?;

    let mut stream =
        TcpStream::connect_timeout(&addr, TIMEOUT).map_err(|e| format!("{SERVER}: {e}"))?;
    stream.set_read_timeout(Some(TIMEOUT)).ok();
    stream.set_write_timeout(Some(TIMEOUT)).ok();

    stream
        .write_all(build_query(ips).as_bytes())
        .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    // Deliberately *not* half-closing the write side afterwards. It looks like
    // the tidy thing to do, and `netcat < file` does it, but this server reads
    // it as the client giving up and closes without answering — an empty
    // response every time. The `end` line is what terminates a bulk query.

    let mut body = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut reader = stream.take(MAX_RESPONSE);
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            // Read what arrived rather than failing: a server that answers and
            // then holds the socket open would otherwise throw away a perfectly
            // good response the moment the timeout fired.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Remembers answers for the life of the process.
///
/// Traces to nearby targets share most of their path, so without this the same
/// dozen routers get looked up on every run.
#[derive(Default)]
pub struct AsnCache {
    entries: Mutex<HashMap<Ipv4Addr, AsnInfo>>,
}

impl AsnCache {
    /// Looks up whatever is public and not already known.
    ///
    /// Returns only what could be resolved: private hops and lookup failures
    /// are simply absent, and the caller shows the hop without a network name.
    pub fn resolve(&self, ips: &[Ipv4Addr]) -> Vec<AsnInfo> {
        let mut known = Vec::new();
        let mut missing = Vec::new();

        {
            let cache = self.entries.lock().unwrap();
            for ip in ips {
                if !is_public(*ip) {
                    continue;
                }
                match cache.get(ip) {
                    Some(hit) => known.push(hit.clone()),
                    None if !missing.contains(ip) => missing.push(*ip),
                    None => {}
                }
            }
        }

        if missing.is_empty() {
            return known;
        }

        // A blocked port 43 is entirely plausible on a corporate network, and a
        // trace without network names is still a useful trace.
        let Ok(body) = query(&missing) else {
            return known;
        };

        let fetched = parse_response(&body);
        {
            let mut cache = self.entries.lock().unwrap();
            for info in &fetched {
                if let Ok(ip) = info.ip.parse::<Ipv4Addr>() {
                    cache.insert(ip, info.clone());
                }
            }
        }

        known.extend(fetched);
        known
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn public_addresses_are_lookupable() {
        for s in ["1.1.1.1", "8.8.8.8", "154.54.30.122", "216.239.40.187"] {
            assert!(is_public(ip(s)), "{s} should be public");
        }
    }

    #[test]
    fn private_ranges_never_leave_the_machine() {
        for s in [
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.1",
            "192.168.86.1",
            "127.0.0.1",
            "169.254.1.1",
        ] {
            assert!(!is_public(ip(s)), "{s} must not be sent anywhere");
        }
    }

    #[test]
    fn carrier_grade_nat_is_not_public() {
        // 100.64/10. Real traces are full of these and they look routable —
        // the live trace to 8.8.8.8 crossed 100.126.59.85 and 100.123.0.10.
        for s in [
            "100.64.0.1",
            "100.126.59.85",
            "100.123.0.10",
            "100.127.255.255",
        ] {
            assert!(!is_public(ip(s)), "{s} is CGNAT, not public");
        }
        // The neighbouring space in 100/8 genuinely is public.
        assert!(is_public(ip("100.63.255.255")));
        assert!(is_public(ip("100.128.0.1")));
    }

    #[test]
    fn reserved_and_special_ranges_are_excluded() {
        for s in [
            "0.0.0.0",
            "192.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.19.255.1",
            "198.51.100.7",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public(ip(s)), "{s} must be excluded");
        }
    }

    #[test]
    fn builds_a_bulk_query() {
        let q = build_query(&[ip("1.1.1.1"), ip("8.8.8.8")]);
        assert_eq!(q, "begin\nverbose\n1.1.1.1\n8.8.8.8\nend\n");
    }

    #[test]
    fn parses_a_real_response() {
        let body = "Bulk mode; whois.cymru.com [2026-08-12 14:00:00 +0000]\n\
             13335   | 1.1.1.1          | 1.1.1.0/24          | US | arin     | 2010-07-14 | CLOUDFLARENET, US\n\
             15169   | 8.8.8.8          | 8.8.8.0/24          | US | arin     | 1992-12-01 | GOOGLE, US\n";

        let got = parse_response(body);
        assert_eq!(got.len(), 2, "the banner line must be skipped");
        assert_eq!(
            got[0],
            AsnInfo {
                ip: "1.1.1.1".into(),
                asn: Some(13335),
                name: Some("CLOUDFLARENET".into()),
                prefix: Some("1.1.1.0/24".into()),
                country: Some("US".into()),
            }
        );
        assert_eq!(got[1].asn, Some(15169));
        assert_eq!(got[1].name.as_deref(), Some("GOOGLE"));
    }

    #[test]
    fn parses_the_operator_names_the_service_actually_returns() {
        // Captured live: richer than the bare handle, and the embedded comma in
        // "Inc.," is exactly the case the country-code strip must not mangle.
        let body = "13335   | 1.1.1.1          | 1.1.1.0/24          | AU | apnic    | 2011-08-11 | CLOUDFLARENET - Cloudflare, Inc., US\n\
             15169   | 8.8.8.8          | 8.8.8.0/24          | US | arin     | 2023-12-28 | GOOGLE - Google LLC, US\n";

        let got = parse_response(body);
        assert_eq!(got.len(), 2);
        assert_eq!(
            got[0].name.as_deref(),
            Some("CLOUDFLARENET - Cloudflare, Inc.")
        );
        assert_eq!(got[0].country.as_deref(), Some("AU"));
        assert_eq!(got[1].name.as_deref(), Some("GOOGLE - Google LLC"));
    }

    #[test]
    fn parses_an_unannounced_address() {
        let body =
            "NA      | 192.0.2.1        | NA                  |    |          |            | NA\n";
        let got = parse_response(body);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].asn, None);
        assert_eq!(got[0].name, None);
        assert_eq!(got[0].prefix, None);
        assert_eq!(got[0].country, None);
    }

    #[test]
    fn ignores_lines_that_are_not_results() {
        let body = "Bulk mode; whois.cymru.com\n\nsome error text\n| | | | | | |\n";
        assert!(parse_response(body).is_empty());
    }

    #[test]
    fn strips_the_trailing_country_from_the_operator_name() {
        assert_eq!(
            clean_name("CLOUDFLARENET, US").as_deref(),
            Some("CLOUDFLARENET")
        );
        assert_eq!(clean_name("COGENT-174, US").as_deref(), Some("COGENT-174"));
    }

    #[test]
    fn keeps_a_name_whose_suffix_is_not_a_country_code() {
        // Only an exact two-letter uppercase suffix is a country code.
        assert_eq!(clean_name("EXAMPLE, Inc").as_deref(), Some("EXAMPLE, Inc"));
        assert_eq!(
            clean_name("SOME-NET, GmbH").as_deref(),
            Some("SOME-NET, GmbH")
        );
    }

    #[test]
    fn treats_na_and_blank_names_as_absent() {
        assert_eq!(clean_name("NA"), None);
        assert_eq!(clean_name("   "), None);
    }

    #[test]
    fn the_cache_skips_private_addresses_entirely() {
        // No network access: with only private addresses there is nothing to
        // ask about, so this must return without attempting a connection.
        let cache = AsnCache::default();
        let got = cache.resolve(&[ip("192.168.1.1"), ip("10.0.0.1"), ip("127.0.0.1")]);
        assert!(got.is_empty());
    }

    /// Hits the real service. Ignored by default so the suite stays offline.
    #[test]
    #[ignore]
    fn live_lookup_names_cloudflare_and_google() {
        let cache = AsnCache::default();
        let got = cache.resolve(&[ip("1.1.1.1"), ip("8.8.8.8"), ip("192.168.1.1")]);

        assert_eq!(got.len(), 2, "the private address must be skipped");
        let names: Vec<_> = got.iter().filter_map(|a| a.name.clone()).collect();
        assert!(
            names.iter().any(|n| n.contains("CLOUDFLARE")),
            "expected Cloudflare, got {names:?}"
        );

        // Second call must be served from the cache.
        let again = cache.resolve(&[ip("1.1.1.1")]);
        assert_eq!(again.len(), 1);
    }
}
