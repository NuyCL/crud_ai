//! Timestamps as milliseconds since the Unix epoch, written as RFC 3339 in UTC with millisecond precision
//! (`2026-01-31T08:00:00.250Z`). Written by hand: no date-time dependency is in CONVENTIONS.md.

use std::time::{SystemTime, UNIX_EPOCH};

const MS_PER_DAY: i64 = 86_400_000;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of `days_from_civil`.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn format_time(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let rest = ms.rem_euclid(MS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// Parse the exact format `format_time` writes; `None` for anything else.
pub fn parse_time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 24
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[23] != b'Z'
    {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let digits = &b[from..to];
        if digits.iter().all(u8::is_ascii_digit) { std::str::from_utf8(digits).ok()?.parse().ok() } else { None }
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec, milli) = (num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    Some(days_from_civil(y, mo, d) * MS_PER_DAY + h * 3_600_000 + mi * 60_000 + sec * 1000 + milli)
}

/// The current time, truncated to the millisecond.
pub fn now_ms() -> i64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

/// Whether `year` is a leap year in the Gregorian calendar.
pub fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(format_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_time(1_769_846_400_250), "2026-01-31T08:00:00.250Z");
        assert_eq!(format_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(format_time(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn parse_is_the_inverse_of_format() {
        for ms in [0, 1, 999, 1_769_846_400_250, 951_782_400_000, 4_102_444_799_999, -86_400_000, -1] {
            assert_eq!(parse_time(&format_time(ms)), Some(ms), "{ms}");
        }
    }

    #[test]
    fn parse_rejects_other_shapes() {
        for s in [
            "",
            "2026-01-31T08:00:00Z",
            "2026-01-31 08:00:00.250Z",
            "2026-01-31T08:00:00.250+00:00",
            "2026-01-31T08:00:00.25Z",
            "x026-01-31T08:00:00.250Z",
        ] {
            assert_eq!(parse_time(s), None, "{s}");
        }
    }

    #[test]
    fn leap_years() {
        assert!(is_leap(2028) && is_leap(2000) && !is_leap(1900) && !is_leap(2027));
    }
}
