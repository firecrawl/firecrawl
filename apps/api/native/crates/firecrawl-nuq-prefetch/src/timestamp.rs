//! PostgreSQL `timestamptz` text parser and ES262 `Date.prototype.toISOString()`
//! formatter with exact millisecond truncation parity.

use thiserror::Error;

/// ES262 `Date` valid range in milliseconds from Unix epoch (`+-8.64e15` ms).
pub const JS_DATE_MAX_EPOCH_MILLIS: i64 = 8_640_000_000_000_000;
const SECS_PER_DAY: i64 = 86_400;
const MILLIS_PER_SEC: i64 = 1_000;

/// Errors returned when decoding or formatting a PostgreSQL timestamp.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TimestampError {
  #[error("invalid PostgreSQL timestamp syntax")]
  InvalidSyntax,
  #[error("calendar or clock component out of range")]
  OutOfRange,
  #[error("timestamp outside JavaScript Date range")]
  OutsideJsDateRange,
}

/// Parses a PostgreSQL ISO `timestamptz` / `timestamp` text representation and
/// formats it as an ES262 `Date.prototype.toISOString()` UTC millisecond string
/// (for example `"2026-11-26T02:00:00.123Z"`).
pub fn parse_pg_timestamp_to_iso_utc(raw: &str) -> Result<String, TimestampError> {
  let epoch_ms = parse_pg_timestamp_to_epoch_millis(raw)?;
  format_epoch_millis_iso_utc(epoch_ms)
}

/// Parses a PostgreSQL ISO `timestamptz` / `timestamp` text representation into
/// UTC milliseconds since Unix epoch, matching `postgres-date` truncation to
/// whole milliseconds.
pub fn parse_pg_timestamp_to_epoch_millis(raw: &str) -> Result<i64, TimestampError> {
  let trimmed = raw.trim();
  let (body, is_bc) = match trimmed.strip_suffix(" BC") {
    Some(prefix) => (prefix, true),
    None => (trimmed, false),
  };

  let sep_idx = body
    .find([' ', 'T', 't'])
    .ok_or(TimestampError::InvalidSyntax)?;
  let date_part = body.get(..sep_idx).ok_or(TimestampError::InvalidSyntax)?;
  let rest = body
    .get(
      sep_idx
        .checked_add(1)
        .ok_or(TimestampError::InvalidSyntax)?..,
    )
    .ok_or(TimestampError::InvalidSyntax)?;

  let (raw_year, month, day) = parse_date(date_part)?;
  // PostgreSQL BC years use astronomical numbering offset by 1 (1 BC == year 0).
  let year = if is_bc {
    1_i64
      .checked_sub(raw_year)
      .ok_or(TimestampError::OutOfRange)?
  } else {
    raw_year
  };

  let (time_part, tz_offset_secs) = split_time_and_offset(rest)?;
  let (hour, minute, second, millis) = parse_time(time_part)?;

  let days = days_from_civil(year, month, day)?;
  let sec_of_day = i64::from(hour)
    .checked_mul(3_600)
    .and_then(|v| v.checked_add(i64::from(minute).checked_mul(60)?))
    .and_then(|v| v.checked_add(i64::from(second)))
    .ok_or(TimestampError::OutOfRange)?;

  let utc_secs = days
    .checked_mul(SECS_PER_DAY)
    .and_then(|v| v.checked_add(sec_of_day))
    .and_then(|v| v.checked_sub(tz_offset_secs))
    .ok_or(TimestampError::OutOfRange)?;

  // Keep millisecond truncation aligned with wall-clock fractional digits
  // (e.g., 1969-12-31 23:59:59.999999+00 -> -1000 + 999 = -1 ms -> .999Z).
  let epoch_ms = utc_secs
    .checked_mul(MILLIS_PER_SEC)
    .and_then(|v| v.checked_add(i64::from(millis)))
    .ok_or(TimestampError::OutsideJsDateRange)?;

  if !(-JS_DATE_MAX_EPOCH_MILLIS..=JS_DATE_MAX_EPOCH_MILLIS).contains(&epoch_ms) {
    return Err(TimestampError::OutsideJsDateRange);
  }

  Ok(epoch_ms)
}

/// Formats UTC epoch milliseconds identically to `new Date(ms).toISOString()`.
pub fn format_epoch_millis_iso_utc(epoch_ms: i64) -> Result<String, TimestampError> {
  if !(-JS_DATE_MAX_EPOCH_MILLIS..=JS_DATE_MAX_EPOCH_MILLIS).contains(&epoch_ms) {
    return Err(TimestampError::OutsideJsDateRange);
  }

  let utc_secs = epoch_ms.div_euclid(MILLIS_PER_SEC);
  let millis = epoch_ms.rem_euclid(MILLIS_PER_SEC);

  let days = utc_secs.div_euclid(SECS_PER_DAY);
  let sec_of_day = utc_secs.rem_euclid(SECS_PER_DAY);

  let (year, month, day) = civil_from_days(days)?;
  let hour = sec_of_day / 3_600;
  let minute = (sec_of_day % 3_600) / 60;
  let second = sec_of_day % 60;

  if (0..=9_999).contains(&year) {
    Ok(format!(
      "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
  } else if year > 9_999 {
    Ok(format!(
      "+{year:06}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
  } else {
    let abs_year = year.unsigned_abs();
    Ok(format!(
      "-{abs_year:06}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
  }
}

fn parse_date(s: &str) -> Result<(i64, u32, u32), TimestampError> {
  let (sign, rest) = if let Some(stripped) = s.strip_prefix('-') {
    (-1_i64, stripped)
  } else if let Some(stripped) = s.strip_prefix('+') {
    (1_i64, stripped)
  } else {
    (1_i64, s)
  };

  let mut parts = rest.split('-');
  let y_str = parts.next().ok_or(TimestampError::InvalidSyntax)?;
  let m_str = parts.next().ok_or(TimestampError::InvalidSyntax)?;
  let d_str = parts.next().ok_or(TimestampError::InvalidSyntax)?;
  if parts.next().is_some()
    || y_str.len() < 4
    || m_str.len() != 2
    || d_str.len() != 2
    || !y_str.bytes().all(|b| b.is_ascii_digit())
    || !m_str.bytes().all(|b| b.is_ascii_digit())
    || !d_str.bytes().all(|b| b.is_ascii_digit())
  {
    return Err(TimestampError::InvalidSyntax);
  }

  let abs_year = y_str
    .parse::<i64>()
    .map_err(|_| TimestampError::OutOfRange)?;
  let year = abs_year
    .checked_mul(sign)
    .ok_or(TimestampError::OutOfRange)?;
  let month = m_str
    .parse::<u32>()
    .map_err(|_| TimestampError::OutOfRange)?;
  let day = d_str
    .parse::<u32>()
    .map_err(|_| TimestampError::OutOfRange)?;

  if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
    return Err(TimestampError::OutOfRange);
  }

  Ok((year, month, day))
}

fn split_time_and_offset(s: &str) -> Result<(&str, i64), TimestampError> {
  if let Some(time) = s.strip_suffix(['Z', 'z']) {
    return Ok((time, 0));
  }

  if let Some(tz_pos) = s.rfind(['+', '-']) {
    let time_part = s.get(..tz_pos).ok_or(TimestampError::InvalidSyntax)?;
    let tz_part = s.get(tz_pos..).ok_or(TimestampError::InvalidSyntax)?;
    let offset_secs = parse_tz_offset(tz_part)?;
    return Ok((time_part, offset_secs));
  }

  // Timestamp without time zone: treat as UTC.
  Ok((s, 0))
}

fn parse_tz_offset(s: &str) -> Result<i64, TimestampError> {
  let (sign, rest) = if let Some(stripped) = s.strip_prefix('+') {
    (1_i64, stripped)
  } else if let Some(stripped) = s.strip_prefix('-') {
    (-1_i64, stripped)
  } else {
    return Err(TimestampError::InvalidSyntax);
  };

  let (oh, om, os) = if rest.contains(':') {
    let mut parts = rest.split(':');
    let h = parse_two_digits(parts.next().ok_or(TimestampError::InvalidSyntax)?)?;
    let m = parse_two_digits(parts.next().ok_or(TimestampError::InvalidSyntax)?)?;
    let sec = match parts.next() {
      Some(sec_str) => parse_two_digits(sec_str)?,
      None => 0,
    };
    if parts.next().is_some() {
      return Err(TimestampError::InvalidSyntax);
    }
    (h, m, sec)
  } else {
    match rest.len() {
      2 => (parse_two_digits(rest)?, 0, 0),
      4 => {
        let h_str = rest.get(0..2).ok_or(TimestampError::InvalidSyntax)?;
        let m_str = rest.get(2..4).ok_or(TimestampError::InvalidSyntax)?;
        (parse_two_digits(h_str)?, parse_two_digits(m_str)?, 0)
      }
      6 => {
        let h_str = rest.get(0..2).ok_or(TimestampError::InvalidSyntax)?;
        let m_str = rest.get(2..4).ok_or(TimestampError::InvalidSyntax)?;
        let s_str = rest.get(4..6).ok_or(TimestampError::InvalidSyntax)?;
        (
          parse_two_digits(h_str)?,
          parse_two_digits(m_str)?,
          parse_two_digits(s_str)?,
        )
      }
      _ => return Err(TimestampError::InvalidSyntax),
    }
  };

  if oh > 23 || om > 59 || os > 59 {
    return Err(TimestampError::OutOfRange);
  }

  let total = i64::from(oh)
    .checked_mul(3_600)
    .and_then(|v| v.checked_add(i64::from(om).checked_mul(60)?))
    .and_then(|v| v.checked_add(i64::from(os)))
    .and_then(|v| v.checked_mul(sign))
    .ok_or(TimestampError::OutOfRange)?;
  Ok(total)
}

fn parse_time(s: &str) -> Result<(u32, u32, u32, u16), TimestampError> {
  let (hms, frac_opt) = match s.split_once('.') {
    Some((lhs, rhs)) => (lhs, Some(rhs)),
    None => (s, None),
  };

  let mut parts = hms.split(':');
  let h = parse_two_digits(parts.next().ok_or(TimestampError::InvalidSyntax)?)?;
  let m = parse_two_digits(parts.next().ok_or(TimestampError::InvalidSyntax)?)?;
  let sec = parse_two_digits(parts.next().ok_or(TimestampError::InvalidSyntax)?)?;
  if parts.next().is_some() {
    return Err(TimestampError::InvalidSyntax);
  }
  if h > 23 || m > 59 || sec > 59 {
    return Err(TimestampError::OutOfRange);
  }

  let millis = match frac_opt {
    None => 0_u16,
    Some(frac) => {
      if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return Err(TimestampError::InvalidSyntax);
      }
      let mut bytes = frac.bytes();
      let d1 = bytes
        .next()
        .map_or(0_u16, |b| u16::from(b.wrapping_sub(b'0')));
      let d2 = bytes
        .next()
        .map_or(0_u16, |b| u16::from(b.wrapping_sub(b'0')));
      let d3 = bytes
        .next()
        .map_or(0_u16, |b| u16::from(b.wrapping_sub(b'0')));
      d1.saturating_mul(100)
        .saturating_add(d2.saturating_mul(10))
        .saturating_add(d3)
    }
  };

  Ok((h, m, sec, millis))
}

fn parse_two_digits(s: &str) -> Result<u32, TimestampError> {
  if s.len() != 2 || !s.bytes().all(|b| b.is_ascii_digit()) {
    return Err(TimestampError::InvalidSyntax);
  }
  s.parse::<u32>().map_err(|_| TimestampError::InvalidSyntax)
}

fn is_leap_year(year: i64) -> bool {
  (year.rem_euclid(4) == 0 && year.rem_euclid(100) != 0) || year.rem_euclid(400) == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
  match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 if is_leap_year(year) => 29,
    2 => 28,
    _ => 0,
  }
}

/// Howard Hinnant's proleptic Gregorian days-since-1970-01-01 calculation.
fn days_from_civil(year: i64, month: u32, day: u32) -> Result<i64, TimestampError> {
  let y = if month <= 2 {
    year.checked_sub(1).ok_or(TimestampError::OutOfRange)?
  } else {
    year
  };
  let era = y.div_euclid(400);
  let yoe = y.rem_euclid(400);
  let m = i64::from(month);
  let d = i64::from(day);
  let mp = if m > 2 {
    m.checked_sub(3)
  } else {
    m.checked_add(9)
  }
  .ok_or(TimestampError::OutOfRange)?;
  let doy = mp
    .checked_mul(153)
    .and_then(|v| v.checked_add(2))
    .map(|v| v / 5)
    .and_then(|v| v.checked_add(d))
    .and_then(|v| v.checked_sub(1))
    .ok_or(TimestampError::OutOfRange)?;
  let doe = yoe
    .checked_mul(365)
    .and_then(|v| v.checked_add(yoe / 4))
    .and_then(|v| v.checked_sub(yoe / 100))
    .and_then(|v| v.checked_add(doy))
    .ok_or(TimestampError::OutOfRange)?;

  era
    .checked_mul(146_097)
    .and_then(|v| v.checked_add(doe))
    .and_then(|v| v.checked_sub(719_468))
    .ok_or(TimestampError::OutOfRange)
}

/// Inverse of [`days_from_civil`]: days since 1970-01-01 to `(year, month, day)`.
fn civil_from_days(days: i64) -> Result<(i64, u32, u32), TimestampError> {
  let z = days
    .checked_add(719_468)
    .ok_or(TimestampError::OutsideJsDateRange)?;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe
    .checked_sub(doe / 1_460)
    .and_then(|v| v.checked_add(doe / 36_524))
    .and_then(|v| v.checked_sub(doe / 146_096))
    .ok_or(TimestampError::OutOfRange)?)
    / 365;
  let y = yoe
    .checked_add(era.checked_mul(400).ok_or(TimestampError::OutOfRange)?)
    .ok_or(TimestampError::OutOfRange)?;
  let doy = doe
    .checked_sub(
      yoe
        .checked_mul(365)
        .and_then(|v| v.checked_add(yoe / 4))
        .and_then(|v| v.checked_sub(yoe / 100))
        .ok_or(TimestampError::OutOfRange)?,
    )
    .ok_or(TimestampError::OutOfRange)?;
  let mp = (doy
    .checked_mul(5)
    .and_then(|v| v.checked_add(2))
    .ok_or(TimestampError::OutOfRange)?)
    / 153;
  let d = doy
    .checked_sub(
      (mp
        .checked_mul(153)
        .and_then(|v| v.checked_add(2))
        .ok_or(TimestampError::OutOfRange)?)
        / 5,
    )
    .and_then(|v| v.checked_add(1))
    .ok_or(TimestampError::OutOfRange)?;
  let m = if mp < 10 {
    mp.checked_add(3)
  } else {
    mp.checked_sub(9)
  }
  .ok_or(TimestampError::OutOfRange)?;
  let year = if m <= 2 {
    y.checked_add(1).ok_or(TimestampError::OutOfRange)?
  } else {
    y
  };

  let month = u32::try_from(m).map_err(|_| TimestampError::OutOfRange)?;
  let day = u32::try_from(d).map_err(|_| TimestampError::OutOfRange)?;
  Ok((year, month, day))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn matches_postgres_date_and_js_to_iso_string_cases() {
    let cases = [
      ("2026-11-26 02:00:00+00", "2026-11-26T02:00:00.000Z"),
      ("2026-11-26 02:00:00.5+00", "2026-11-26T02:00:00.500Z"),
      ("2026-11-26 02:00:00.123456+00", "2026-11-26T02:00:00.123Z"),
      ("2026-11-26 02:00:00.123999+00", "2026-11-26T02:00:00.123Z"),
      ("2026-11-26 02:00:00.999999+00", "2026-11-26T02:00:00.999Z"),
      ("2026-11-26 02:00:00.123-05:30", "2026-11-26T07:30:00.123Z"),
      (
        "2026-11-26 02:00:00.123+05:30:15",
        "2026-11-25T20:29:45.123Z",
      ),
      ("1969-12-31 23:59:59.999999+00", "1969-12-31T23:59:59.999Z"),
      ("1969-12-31 23:59:59.000001+00", "1969-12-31T23:59:59.000Z"),
      ("1970-01-01 00:00:00+00", "1970-01-01T00:00:00.000Z"),
      ("2000-02-29 12:34:56.007+00", "2000-02-29T12:34:56.007Z"),
      ("2026-11-26T02:00:00.123Z", "2026-11-26T02:00:00.123Z"),
    ];

    for (input, expected) in cases {
      assert_eq!(
        parse_pg_timestamp_to_iso_utc(input),
        Ok(expected.to_owned()),
        "input: {input}"
      );
    }
  }

  #[test]
  fn rejects_invalid_dates_and_syntax() {
    assert!(parse_pg_timestamp_to_iso_utc("2025-02-29 00:00:00+00").is_err());
    assert!(parse_pg_timestamp_to_iso_utc("2026-13-01 00:00:00+00").is_err());
    assert!(parse_pg_timestamp_to_iso_utc("2026-11-26 24:00:00+00").is_err());
    assert!(parse_pg_timestamp_to_iso_utc("2026-11-26 00:00:00.+00").is_err());
    assert!(parse_pg_timestamp_to_iso_utc("not-a-timestamp").is_err());
  }
}
