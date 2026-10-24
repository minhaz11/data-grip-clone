//! Type inference from a sample, and per-row checks against the target column types, so a bad
//! value is reported with its line (and, with the Skip or NULL policies, handled) before it
//! reaches the server, where one bad row would abort the whole COPY.

use std::borrow::Cow;

/// The most specific PostgreSQL type every non-NULL sample value fits.
pub fn infer_type<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> &'static str {
    const ORDER: [&str; 10] = [
        "boolean",
        "integer",
        "bigint",
        "numeric",
        "date",
        "timestamp",
        "timestamp with time zone",
        "uuid",
        "jsonb",
        "text",
    ];
    let mut fits = [true; ORDER.len()];
    let mut any = false;
    for v in values.into_iter().flatten() {
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        any = true;
        for (i, ty) in ORDER.iter().enumerate() {
            if fits[i] && Converter::for_type(ty).convert(v).is_err() {
                fits[i] = false;
            }
        }
    }
    if !any {
        return "text";
    }
    // 0 and 1 also fit integer: a column of only 0/1 is more likely a number.
    let start = usize::from(fits[1]);
    ORDER
        .iter()
        .zip(fits)
        .skip(start)
        .find(|(_, ok)| *ok)
        .map_or("text", |(ty, _)| ty)
}

/// Checks and normalizes values for one target column type. Types it does not know are passed
/// through for the server to check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Converter {
    Int {
        min: i64,
        max: i64,
    },
    Numeric {
        int_digits: Option<u32>,
    },
    Float,
    Bool,
    Date,
    Timestamp {
        zone: bool,
    },
    Time,
    Uuid,
    Json,
    /// Text with a length limit (`varchar(n)`, `char(n)`).
    Chars(usize),
    Any,
}

impl Converter {
    pub fn for_type(type_name: &str) -> Self {
        let t = type_name.trim().to_ascii_lowercase();
        let (base, args) = match t.find('(') {
            Some(i) => (t[..i].trim(), t[i + 1..].trim_end_matches(')').trim()),
            None => (t.as_str(), ""),
        };
        let arg = |n: usize| {
            args.split(',')
                .nth(n)
                .and_then(|a| a.trim().parse::<u32>().ok())
        };
        match base {
            "smallint" | "int2" | "smallserial" | "serial2" => Self::Int {
                min: i64::from(i16::MIN),
                max: i64::from(i16::MAX),
            },
            "integer" | "int" | "int4" | "serial" | "serial4" => Self::Int {
                min: i64::from(i32::MIN),
                max: i64::from(i32::MAX),
            },
            "bigint" | "int8" | "bigserial" | "serial8" => Self::Int {
                min: i64::MIN,
                max: i64::MAX,
            },
            "numeric" | "decimal" => Self::Numeric {
                int_digits: match (arg(0), arg(1)) {
                    (Some(p), s) => Some(p.saturating_sub(s.unwrap_or(0))),
                    (None, _) => None,
                },
            },
            "real" | "float4" | "double precision" | "float8" | "float" => Self::Float,
            "boolean" | "bool" => Self::Bool,
            "date" => Self::Date,
            "timestamp" | "timestamp without time zone" => Self::Timestamp { zone: false },
            "timestamptz" | "timestamp with time zone" => Self::Timestamp { zone: true },
            "time" | "time without time zone" => Self::Time,
            "uuid" => Self::Uuid,
            "json" | "jsonb" => Self::Json,
            "character varying" | "varchar" | "character" | "char" | "bpchar" => match arg(0) {
                Some(n) => Self::Chars(n as usize),
                None => Self::Any,
            },
            _ => Self::Any,
        }
    }

    /// The value as the server should receive it, or why it does not fit.
    pub fn convert<'a>(&self, v: &'a str) -> Result<Cow<'a, str>, String> {
        match self {
            Self::Int { min, max } => {
                let t = v.trim();
                match t.parse::<i64>() {
                    Ok(n) if (*min..=*max).contains(&n) => Ok(Cow::Borrowed(t)),
                    Ok(_) => Err(format!("{t} is out of range")),
                    Err(_) => Err(format!("\"{v}\" is not a whole number")),
                }
            }
            Self::Numeric { int_digits } => {
                let t = v.trim();
                if is_special_float(t) {
                    return Ok(Cow::Borrowed(t));
                }
                if !is_decimal(t) {
                    return Err(format!("\"{v}\" is not a number"));
                }
                if let Some(limit) = int_digits {
                    let digits = t
                        .trim_start_matches(['+', '-'])
                        .split(['.', 'e', 'E'])
                        .next()
                        .unwrap_or("")
                        .trim_start_matches('0')
                        .len();
                    if digits as u32 > *limit {
                        return Err(format!("{t} has too many digits for the column"));
                    }
                }
                Ok(Cow::Borrowed(t))
            }
            Self::Float => {
                let t = v.trim();
                if is_decimal(t) || is_special_float(t) {
                    Ok(Cow::Borrowed(t))
                } else {
                    Err(format!("\"{v}\" is not a number"))
                }
            }
            Self::Bool => match v.trim().to_ascii_lowercase().as_str() {
                "t" | "true" | "y" | "yes" | "on" | "1" => Ok(Cow::Borrowed("t")),
                "f" | "false" | "n" | "no" | "off" | "0" => Ok(Cow::Borrowed("f")),
                _ => Err(format!("\"{v}\" is not true or false")),
            },
            Self::Date => {
                let t = v.trim();
                if is_date(t) {
                    Ok(Cow::Borrowed(t))
                } else {
                    Err(format!("\"{v}\" is not a date (YYYY-MM-DD)"))
                }
            }
            Self::Timestamp { zone } => {
                let t = v.trim();
                if is_timestamp(t, *zone) {
                    Ok(Cow::Borrowed(t))
                } else if *zone {
                    Err(format!("\"{v}\" is not a timestamp with a time zone"))
                } else {
                    Err(format!("\"{v}\" is not a timestamp (YYYY-MM-DD HH:MM:SS)"))
                }
            }
            Self::Time => {
                let t = v.trim();
                if is_time(t) {
                    Ok(Cow::Borrowed(t))
                } else {
                    Err(format!("\"{v}\" is not a time (HH:MM[:SS])"))
                }
            }
            Self::Uuid => {
                let t = v.trim();
                let hex: String = t
                    .trim_start_matches('{')
                    .trim_end_matches('}')
                    .chars()
                    .filter(|c| *c != '-')
                    .collect();
                if hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    Ok(Cow::Borrowed(t))
                } else {
                    Err(format!("\"{v}\" is not a UUID"))
                }
            }
            Self::Json => match serde_json::from_str::<serde::de::IgnoredAny>(v) {
                Ok(_) => Ok(Cow::Borrowed(v)),
                Err(e) => Err(format!("invalid JSON: {e}")),
            },
            Self::Chars(n) => {
                if v.chars().count() <= *n {
                    Ok(Cow::Borrowed(v))
                } else {
                    Err(format!("longer than {n} characters"))
                }
            }
            Self::Any => Ok(Cow::Borrowed(v)),
        }
    }
}

fn is_special_float(t: &str) -> bool {
    matches!(
        t.to_ascii_lowercase().as_str(),
        "nan" | "infinity" | "+infinity" | "-infinity" | "inf" | "+inf" | "-inf"
    )
}

/// `[+-]digits[.digits][e[+-]digits]`, with digits on at least one side of the point.
fn is_decimal(t: &str) -> bool {
    let s = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let (int, frac) = match mantissa.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (mantissa, None),
    };
    let digits = |p: &str| p.chars().all(|c| c.is_ascii_digit());
    let mantissa_ok = digits(int)
        && frac.is_none_or(digits)
        && (!int.is_empty() || frac.is_some_and(|f| !f.is_empty()));
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    mantissa_ok && exponent_ok
}

fn number(s: &str, len: usize) -> Option<u32> {
    (s.len() == len && s.chars().all(|c| c.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

fn is_date(t: &str) -> bool {
    let mut parts = t.splitn(3, '-');
    let (Some(y), Some(m), Some(d)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let (Some(y), Some(m), Some(d)) = (number(y, 4), number(m, 2), number(d, 2)) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// `HH:MM[:SS[.fraction]]`.
fn is_time(t: &str) -> bool {
    let (clock, fraction) = match t.split_once('.') {
        Some((c, f)) => (c, Some(f)),
        None => (t, None),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    let ok = match parts.as_slice() {
        [h, m] => number(h, 2).is_some_and(|h| h < 24) && number(m, 2).is_some_and(|m| m < 60),
        [h, m, s] => {
            number(h, 2).is_some_and(|h| h < 24)
                && number(m, 2).is_some_and(|m| m < 60)
                && number(s, 2).is_some_and(|s| s < 61)
        }
        _ => false,
    };
    ok && fraction
        .is_none_or(|f| !f.is_empty() && f.len() <= 9 && f.chars().all(|c| c.is_ascii_digit()))
        && (fraction.is_none() || parts.len() == 3)
}

/// `YYYY-MM-DD[T ]HH:MM[:SS[.f]]`, with `Z` or `±HH[:MM]` exactly when `zone` is set.
fn is_timestamp(t: &str, zone: bool) -> bool {
    let Some((date, rest)) = t.split_once(['T', ' ']) else {
        return false;
    };
    if !is_date(date) {
        return false;
    }
    let rest = rest.trim();
    let (time, offset) = if let Some(time) = rest.strip_suffix(['Z', 'z']) {
        (time, Some("Z"))
    } else {
        match rest.rfind(['+', '-']) {
            Some(i) if i > 0 => (&rest[..i], Some(&rest[i..])),
            _ => (rest, None),
        }
    };
    let offset_ok = offset.is_none_or(|o| {
        if o == "Z" {
            return true;
        }
        let o = &o[1..];
        let (h, m) = o.split_once(':').unwrap_or((o, "00"));
        number(h, 2).is_some_and(|h| h <= 15) && number(m, 2).is_some_and(|m| m < 60)
    });
    is_time(time) && offset_ok && offset.is_some() == zone
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inference_picks_the_most_specific_type() {
        let cases: [(&[&str], &str); 11] = [
            (&["1", "2", "-3"], "integer"),
            (&["1", "3000000000"], "bigint"),
            (&["1.5", "2", "-3e2"], "numeric"),
            (&["0", "1"], "integer"),
            (&["true", "f", "Yes"], "boolean"),
            (&["2024-02-29", "2023-12-31"], "date"),
            (
                &["2024-01-01 10:00", "2024-01-01T10:00:05.123"],
                "timestamp",
            ),
            (
                &["2024-01-01T10:00:00Z", "2024-01-01 10:00:00+02:00"],
                "timestamp with time zone",
            ),
            (&["550e8400-e29b-41d4-a716-446655440000"], "uuid"),
            (&[r#"{"a":1}"#, "[1,2]"], "jsonb"),
            (&["2024-02-30", "x"], "text"),
        ];
        for (values, expected) in cases {
            assert_eq!(
                infer_type(values.iter().map(|v| Some(*v))),
                expected,
                "{values:?}"
            );
        }
        assert_eq!(infer_type([None, Some(""), None]), "text");
        assert_eq!(infer_type([Some("1"), None, Some("2")]), "integer");
    }

    #[test]
    fn conversions_check_ranges_lengths_and_formats() {
        let int = Converter::for_type("smallint");
        assert!(int.convert("32767").is_ok());
        assert!(
            int.convert("32768")
                .expect_err("range")
                .contains("out of range")
        );
        assert_eq!(
            Converter::for_type("boolean")
                .convert(" YES ")
                .expect("bool"),
            "t"
        );
        let money = Converter::for_type("numeric(5,2)");
        assert!(money.convert("123.45").is_ok());
        assert!(money.convert("1234.5").is_err());
        assert!(Converter::for_type("numeric").convert("NaN").is_ok());
        assert!(
            Converter::for_type("double precision")
                .convert("1e-5")
                .is_ok()
        );
        assert!(Converter::for_type("integer").convert("1.0").is_err());
        let code = Converter::for_type("character varying(3)");
        assert!(code.convert("äöü").is_ok());
        assert!(code.convert("abcd").is_err());
        assert!(Converter::for_type("date").convert("2023-02-29").is_err());
        assert!(Converter::for_type("time").convert("23:59:60").is_ok());
        assert!(Converter::for_type("time").convert("24:00").is_err());
        assert!(
            Converter::for_type("uuid")
                .convert("{550E8400E29B41D4A716446655440000}")
                .is_ok()
        );
        assert!(Converter::for_type("jsonb").convert("{bad").is_err());
        assert_eq!(Converter::for_type("tsvector"), Converter::Any);
        assert!(Converter::for_type("text[]").convert("{a,b}").is_ok());
    }
}
