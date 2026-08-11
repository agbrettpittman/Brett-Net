//! Hostname resolution with caching.
//!
//! Resolution deliberately happens *outside* the timed region of a ping. A DNS
//! lookup can take tens of milliseconds and would otherwise be indistinguishable
//! from network latency on the graph.

use std::collections::HashMap;
use std::net::{Ipv4Addr, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

pub trait Resolver: Send + Sync + 'static {
    fn resolve(&self, host: &str) -> Option<Ipv4Addr>;
}

/// Resolves through the OS resolver, honouring whatever DNS the machine uses.
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str) -> Option<Ipv4Addr> {
        // Port is irrelevant; ToSocketAddrs just needs one to parse.
        (host, 0u16)
            .to_socket_addrs()
            .ok()?
            .find_map(|addr| match addr.ip() {
                std::net::IpAddr::V4(v4) => Some(v4),
                _ => None,
            })
    }
}

struct Entry {
    addr: Option<Ipv4Addr>,
    at: Instant,
}

/// Caches resolutions for `ttl`, including negative results, so a dead hostname
/// doesn't trigger a lookup on every single tick.
pub struct DnsCache {
    resolver: Arc<dyn Resolver>,
    entries: RwLock<HashMap<String, Entry>>,
    ttl: Duration,
    lookups: AtomicUsize,
}

impl DnsCache {
    pub fn new(resolver: Arc<dyn Resolver>, ttl: Duration) -> Self {
        Self {
            resolver,
            entries: RwLock::new(HashMap::new()),
            ttl,
            lookups: AtomicUsize::new(0),
        }
    }

    /// Number of times the underlying resolver was actually consulted.
    pub fn lookup_count(&self) -> usize {
        self.lookups.load(Ordering::SeqCst)
    }

    /// Resolves `target`, which may already be an IPv4 literal.
    ///
    /// This blocks, so callers run it on a blocking thread.
    pub fn resolve(&self, target: &str) -> Option<Ipv4Addr> {
        // An IP literal needs no resolver and should never be cached.
        if let Ok(ip) = target.parse::<Ipv4Addr>() {
            return Some(ip);
        }

        if let Some(entry) = self.entries.read().unwrap().get(target) {
            if entry.at.elapsed() < self.ttl {
                return entry.addr;
            }
        }

        self.lookups.fetch_add(1, Ordering::SeqCst);
        let addr = self.resolver.resolve(target);
        self.entries.write().unwrap().insert(
            target.to_string(),
            Entry {
                addr,
                at: Instant::now(),
            },
        );
        addr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Option<Ipv4Addr>);
    impl Resolver for Fixed {
        fn resolve(&self, _host: &str) -> Option<Ipv4Addr> {
            self.0
        }
    }

    fn cache(addr: Option<Ipv4Addr>, ttl: Duration) -> DnsCache {
        DnsCache::new(Arc::new(Fixed(addr)), ttl)
    }

    #[test]
    fn ip_literals_bypass_the_resolver_entirely() {
        let c = cache(None, Duration::from_secs(60));
        assert_eq!(
            c.resolve("192.168.1.1"),
            Some(Ipv4Addr::new(192, 168, 1, 1))
        );
        assert_eq!(c.lookup_count(), 0, "an IP literal must not hit DNS");
    }

    #[test]
    fn hostnames_resolve_once_then_come_from_cache() {
        let want = Ipv4Addr::new(10, 1, 2, 3);
        let c = cache(Some(want), Duration::from_secs(60));

        for _ in 0..5 {
            assert_eq!(c.resolve("example.internal"), Some(want));
        }
        assert_eq!(c.lookup_count(), 1, "repeat lookups should be cached");
    }

    #[test]
    fn failures_are_cached_too() {
        let c = cache(None, Duration::from_secs(60));
        assert_eq!(c.resolve("nope.invalid"), None);
        assert_eq!(c.resolve("nope.invalid"), None);
        assert_eq!(c.lookup_count(), 1, "negative results must be cached");
    }

    #[test]
    fn entries_expire_after_the_ttl() {
        let c = cache(Some(Ipv4Addr::LOCALHOST), Duration::ZERO);
        c.resolve("example.internal");
        c.resolve("example.internal");
        assert_eq!(c.lookup_count(), 2, "a zero TTL must re-resolve every time");
    }

    #[test]
    fn system_resolver_handles_localhost() {
        assert_eq!(
            SystemResolver.resolve("localhost"),
            Some(Ipv4Addr::LOCALHOST)
        );
    }
}
