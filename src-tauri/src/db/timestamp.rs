//! Just enough calendar arithmetic to put readable timestamps in an export.
//!
//! Pulling in a date-time crate for two format functions would cost more in
//! build time and dependency surface than the twenty lines below.

/// Civil date (year, month, day) from a count of days since 1970-01-01.
///
/// Howard Hinnant's `civil_from_days`, valid across the whole proleptic
/// Gregorian calendar. <http://howardhinnant.github.io/date_algorithms.html>
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (y + i64::from(m <= 2), m, d)
}

/// Floored division, so timestamps before 1970 land on the right day rather
/// than truncating toward zero.
fn div_floor(a: i64, b: i64) -> (i64, i64) {
    let q = a.div_euclid(b);
    (q, a - q * b)
}

/// ISO-8601 in UTC, e.g. `2026-08-12T14:32:05.123Z`.
///
/// Exports are UTC deliberately: it is unambiguous, sorts lexicographically,
/// and needs no assumption about which offset was in force when the sample was
/// taken — a seven-day export can straddle a DST change.
pub fn iso_utc(ms: i64) -> String {
    let (days, rem) = div_floor(ms, 86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let (h, rem) = (rem / 3_600_000, rem % 3_600_000);
    let (mi, rem) = (rem / 60_000, rem % 60_000);
    let (s, milli) = (rem / 1000, rem % 1000);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// Filename-safe *local* timestamp, e.g. `2026-08-12_143205`.
///
/// The filename uses local time even though the contents are UTC: a file named
/// for 21:00 when you exported it at 16:00 is confusing to find later.
#[cfg(windows)]
pub fn local_file_stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;

    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02}_{:02}{:02}{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

/// Non-Windows builds exist only so the crate compiles for tooling, so UTC is
/// an acceptable stand-in there.
#[cfg(not(windows))]
pub fn local_file_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // Reshape `2026-08-12T14:32:05.123Z` into `2026-08-12_143205`. ASCII, and
    // `now` is always after the epoch, so the byte offsets are fixed.
    let iso = iso_utc(ms);
    format!(
        "{}_{}{}{}",
        &iso[..10],
        &iso[11..13],
        &iso[14..16],
        &iso[17..19]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_epoch() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn formats_a_known_instant() {
        // 2026-08-12T14:32:05.123Z
        assert_eq!(iso_utc(1_786_545_125_123), "2026-08-12T14:32:05.123Z");
    }

    #[test]
    fn handles_leap_days() {
        // 2024-02-29T00:00:00Z
        assert_eq!(iso_utc(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        // 2000 is a leap year (divisible by 400); 1900 was not.
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn handles_times_before_the_epoch() {
        // Truncating division would give 1970-01-01 here.
        assert_eq!(iso_utc(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn year_boundaries_do_not_slip() {
        assert_eq!(iso_utc(1_767_225_599_000), "2025-12-31T23:59:59.000Z");
        assert_eq!(iso_utc(1_767_225_600_000), "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn file_stamp_is_filename_safe() {
        let s = local_file_stamp();
        assert!(
            !s.contains([':', '/', '\\', '*', '?', '"', '<', '>', '|']),
            "stamp must be usable in a filename, got {s}"
        );
        assert_eq!(s.len(), 17, "expected YYYY-MM-DD_HHMMSS, got {s}");
    }
}
