//! JSON input: one array of objects (read element by element, never as a whole) or one object
//! per line.

use std::fmt;
use std::io::{BufRead, Read};
use std::ops::ControlFlow;

use serde::de::{DeserializeSeed, Deserializer, SeqAccess, Visitor};
use serde_json::{Map, Value};

use super::{ImportError, Record};

type Object = Map<String, Value>;

/// Calls `each` for every object of a top-level JSON array, with its position (1-based).
pub fn read_array<R: Read>(
    reader: R,
    each: &mut dyn FnMut(u64, Object) -> ControlFlow<()>,
) -> Result<(), ImportError> {
    let mut de = serde_json::Deserializer::from_reader(reader);
    let result = de.deserialize_seq(Elements { each });
    match result {
        Ok(()) => Ok(()),
        // `Stop` is how a break from `each` ends the read early.
        Err(e) if e.to_string().starts_with(STOP) => Ok(()),
        Err(e) => Err(ImportError::Syntax {
            line: e.line() as u64,
            message: format!("not a JSON array of objects: {e}"),
        }),
    }
}

const STOP: &str = "quarry: stop";

struct Elements<'a> {
    each: &'a mut dyn FnMut(u64, Object) -> ControlFlow<()>,
}

impl<'de> Visitor<'de> for Elements<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of objects")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let mut index = 0;
        while let Some(object) = seq.next_element_seed(ObjectSeed)? {
            index += 1;
            if (self.each)(index, object).is_break() {
                return Err(serde::de::Error::custom(STOP));
            }
        }
        Ok(())
    }
}

/// An array element that must be an object.
struct ObjectSeed;

impl<'de> DeserializeSeed<'de> for ObjectSeed {
    type Value = Object;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Object, D::Error> {
        match <Value as serde::Deserialize>::deserialize(d)? {
            Value::Object(o) => Ok(o),
            other => Err(serde::de::Error::custom(format!(
                "expected an object, found {}",
                kind(&other)
            ))),
        }
    }
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// Calls `each` for every non-blank line, which must hold one JSON object.
pub fn read_lines<R: BufRead>(
    reader: R,
    each: &mut dyn FnMut(u64, Object) -> ControlFlow<()>,
) -> Result<(), ImportError> {
    for (i, line) in reader.lines().enumerate() {
        let line = line?;
        let n = i as u64 + 1;
        if line.trim().is_empty() {
            continue;
        }
        let object = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Object(o)) => o,
            Ok(other) => {
                return Err(ImportError::Syntax {
                    line: n,
                    message: format!("expected an object, found {}", kind(&other)),
                });
            }
            Err(e) => {
                return Err(ImportError::Syntax {
                    line: n,
                    message: format!("invalid JSON: {e}"),
                });
            }
        };
        if each(n, object).is_break() {
            break;
        }
    }
    Ok(())
}

/// The object's values for `columns`, as text: strings as they are, numbers and booleans as
/// written, nested objects and arrays as JSON, and missing keys or `null` as NULL.
pub fn shape(line: u64, object: &Object, columns: &[String]) -> Record {
    let values = columns
        .iter()
        .map(|c| match object.get(c) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Bool(b)) => Some(b.to_string()),
            Some(Value::Number(n)) => Some(n.to_string()),
            Some(nested) => Some(nested.to_string()),
        })
        .collect();
    Record { line, values }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrays_are_read_element_by_element() {
        let text =
            r#"[{"id": 1, "name": "a", "tags": ["x"]}, {"id": 2, "name": null, "ok": true}]"#;
        let mut got = Vec::new();
        read_array(text.as_bytes(), &mut |i, o| {
            got.push((i, o));
            ControlFlow::Continue(())
        })
        .expect("read");
        assert_eq!(got.len(), 2);
        let columns = ["id", "name", "tags", "ok"].map(String::from);
        let first = shape(got[0].0, &got[0].1, &columns);
        assert_eq!(
            first.values,
            [
                Some("1".into()),
                Some("a".into()),
                Some(r#"["x"]"#.into()),
                None
            ]
        );
        let second = shape(got[1].0, &got[1].1, &columns);
        assert_eq!(second.line, 2);
        assert_eq!(
            second.values,
            [Some("2".into()), None, None, Some("true".into())]
        );
    }

    #[test]
    fn a_break_stops_reading_early() {
        let mut seen = 0;
        read_array(r#"[{"a":1},{"a":2},{"a":3}]"#.as_bytes(), &mut |_, _| {
            seen += 1;
            ControlFlow::Break(())
        })
        .expect("read");
        assert_eq!(seen, 1);
    }

    #[test]
    fn json_lines_skip_blank_lines_and_name_bad_ones() {
        let mut got = Vec::new();
        read_lines("{\"a\":1}\n\n{\"a\":2}\n".as_bytes(), &mut |n, o| {
            got.push((n, o));
            ControlFlow::Continue(())
        })
        .expect("read");
        assert_eq!(got.iter().map(|(n, _)| *n).collect::<Vec<_>>(), [1, 3]);
        let err = read_lines("{\"a\":1}\n[1]\n".as_bytes(), &mut |_, _| {
            ControlFlow::Continue(())
        })
        .expect_err("array line");
        assert!(
            matches!(err, ImportError::Syntax { line: 2, .. }),
            "{err:?}"
        );
        let err = read_array(r#"[{"a":1}, 5]"#.as_bytes(), &mut |_, _| {
            ControlFlow::Continue(())
        })
        .expect_err("not an object");
        assert!(err.to_string().contains("expected an object"), "{err}");
    }
}
