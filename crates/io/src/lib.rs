//! Streaming result export (module H). Rows are written page by page, so exports of any size use
//! constant memory; values arrive in the server's text form and are written without loss.

use std::collections::HashMap;
use std::io::{self, Write};

use quarry_db_core::{Cell, ColumnInfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// RFC 4180 style, `,`-separated, `\n` records, header row. NULL is an empty unquoted field and
    /// an empty string is `""`, so the two stay distinguishable (as with PostgreSQL `COPY … CSV`).
    Csv,
    /// A JSON array of objects keyed by column name.
    Json,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Json => "json",
        }
    }
}

const NUMERIC: &[&str] = &["int2", "int4", "int8", "float4", "float8", "numeric", "oid"];

#[derive(Clone, Copy)]
enum Kind {
    Number,
    Bool,
    Json,
    Text,
}

pub struct ExportWriter<W: Write> {
    out: W,
    format: Format,
    /// JSON object keys (made unique) and how each column is encoded.
    keys: Vec<String>,
    kinds: Vec<Kind>,
    rows: u64,
}

impl<W: Write> ExportWriter<W> {
    pub fn new(mut out: W, format: Format, columns: &[ColumnInfo]) -> io::Result<Self> {
        let kinds = columns
            .iter()
            .map(|c| match c.type_name.as_deref() {
                Some(t) if NUMERIC.contains(&t) => Kind::Number,
                Some("bool") => Kind::Bool,
                Some("json" | "jsonb") => Kind::Json,
                _ => Kind::Text,
            })
            .collect();
        let keys = unique_keys(columns);
        match format {
            Format::Csv => {
                let header: Vec<Cell> = columns.iter().map(|c| Some(c.name.clone())).collect();
                write_csv_record(&mut out, &header)?;
            }
            Format::Json => out.write_all(b"[")?,
        }
        Ok(Self {
            out,
            format,
            keys,
            kinds,
            rows: 0,
        })
    }

    pub fn write_rows(&mut self, rows: &[Vec<Cell>]) -> io::Result<()> {
        for row in rows {
            match self.format {
                Format::Csv => write_csv_record(&mut self.out, row)?,
                Format::Json => {
                    self.out
                        .write_all(if self.rows == 0 { b"\n  {" } else { b",\n  {" })?;
                    for (i, cell) in row.iter().enumerate() {
                        if i > 0 {
                            self.out.write_all(b", ")?;
                        }
                        let key = self.keys.get(i).map_or("", String::as_str);
                        serde_json::to_writer(&mut self.out, key)?;
                        self.out.write_all(b": ")?;
                        write_json_value(
                            &mut self.out,
                            cell.as_deref(),
                            self.kinds.get(i).copied().unwrap_or(Kind::Text),
                        )?;
                    }
                    self.out.write_all(b"}")?;
                }
            }
            self.rows += 1;
        }
        Ok(())
    }

    /// Finishes the document and returns the writer and the number of rows written.
    pub fn finish(mut self) -> io::Result<(W, u64)> {
        if self.format == Format::Json {
            self.out
                .write_all(if self.rows == 0 { b"]\n" } else { b"\n]\n" })?;
        }
        self.out.flush()?;
        Ok((self.out, self.rows))
    }
}

fn unique_keys(columns: &[ColumnInfo]) -> Vec<String> {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    columns
        .iter()
        .map(|c| {
            let n = seen.entry(c.name.as_str()).or_insert(0);
            *n += 1;
            if *n == 1 {
                c.name.clone()
            } else {
                format!("{}_{}", c.name, n)
            }
        })
        .collect()
}

fn write_csv_record(out: &mut impl Write, cells: &[Cell]) -> io::Result<()> {
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            out.write_all(b",")?;
        }
        match cell {
            None => {} // NULL: empty, unquoted
            Some(v) => {
                let quote = v.is_empty()
                    || v.contains([',', '"', '\n', '\r'])
                    || v.starts_with(char::is_whitespace)
                    || v.ends_with(char::is_whitespace);
                if quote {
                    out.write_all(b"\"")?;
                    out.write_all(v.replace('"', "\"\"").as_bytes())?;
                    out.write_all(b"\"")?;
                } else {
                    out.write_all(v.as_bytes())?;
                }
            }
        }
    }
    out.write_all(b"\n")
}

fn write_json_value(out: &mut impl Write, value: Option<&str>, kind: Kind) -> io::Result<()> {
    let Some(v) = value else {
        return out.write_all(b"null");
    };
    match kind {
        // Only syntactically valid JSON numbers go out raw (NaN/Infinity stay strings).
        Kind::Number if is_json_number(v) => out.write_all(v.as_bytes()),
        Kind::Bool if v == "t" || v == "f" => {
            out.write_all(if v == "t" { b"true" } else { b"false" })
        }
        Kind::Json if serde_json::from_str::<&serde_json::value::RawValue>(v).is_ok() => {
            out.write_all(v.as_bytes())
        }
        _ => serde_json::to_writer(&mut *out, v).map_err(io::Error::from),
    }
}

fn is_json_number(v: &str) -> bool {
    let b = v.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'-'));
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    if b.get(i) == Some(&b'0') {
        i += 1;
    } else if !digits(&mut i) {
        return false;
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        if !digits(&mut i) {
            return false;
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            type_name: Some(ty.into()),
        }
    }
    fn s(v: &str) -> Cell {
        Some(v.into())
    }

    fn export(format: Format, columns: &[ColumnInfo], pages: &[Vec<Vec<Cell>>]) -> (String, u64) {
        let mut w = ExportWriter::new(Vec::new(), format, columns).expect("new");
        for p in pages {
            w.write_rows(p).expect("rows");
        }
        let (bytes, n) = w.finish().expect("finish");
        (String::from_utf8(bytes).expect("utf8"), n)
    }

    #[test]
    fn csv_quotes_only_when_needed_and_separates_null_from_empty() {
        let cols = [col("id", "int4"), col("note", "text")];
        let page = vec![
            vec![s("1"), s("plain")],
            vec![s("2"), s("a,b")],
            vec![s("3"), s("say \"hi\"\nbye")],
            vec![s("4"), None],
            vec![s("5"), s("")],
            vec![s("6"), s(" padded ")],
        ];
        let (out, n) = export(Format::Csv, &cols, &[page]);
        assert_eq!(n, 6);
        assert_eq!(
            out,
            "id,note\n1,plain\n2,\"a,b\"\n3,\"say \"\"hi\"\"\nbye\"\n4,\n5,\"\"\n6,\" padded \"\n"
        );
    }

    #[test]
    fn json_types_values_without_precision_loss() {
        let cols = [
            col("big", "int8"),
            col("n", "numeric"),
            col("ok", "bool"),
            col("doc", "jsonb"),
            col("t", "text"),
            col("f", "float8"),
        ];
        let page = vec![
            vec![
                s("9007199254740993"),
                s("12345678901234567890.123"),
                s("t"),
                s("{\"a\": [1, 2]}"),
                s("x \"q\""),
                s("NaN"),
            ],
            vec![None, s("-0.5e-3"), s("f"), s("not json"), s(""), s("1e10")],
        ];
        let (out, n) = export(Format::Json, &cols, &[page]);
        assert_eq!(n, 2);
        assert_eq!(
            out,
            "[\n  {\"big\": 9007199254740993, \"n\": 12345678901234567890.123, \"ok\": true, \"doc\": {\"a\": [1, 2]}, \"t\": \"x \\\"q\\\"\", \"f\": \"NaN\"},\n  {\"big\": null, \"n\": -0.5e-3, \"ok\": false, \"doc\": \"not json\", \"t\": \"\", \"f\": 1e10}\n]\n"
        );
        // Output is valid JSON.
        let parsed: serde_json::Value = serde_json::from_str(&out).expect("valid json");
        assert_eq!(parsed[0]["doc"]["a"][1], 2);
    }

    #[test]
    fn json_disambiguates_duplicate_columns_and_handles_empty() {
        let cols = [col("id", "int4"), col("id", "int4"), col("id", "int4")];
        let (out, _) = export(Format::Json, &cols, &[vec![vec![s("1"), s("2"), s("3")]]]);
        assert!(
            out.contains("{\"id\": 1, \"id_2\": 2, \"id_3\": 3}"),
            "{out}"
        );
        let (empty, n) = export(Format::Json, &cols, &[]);
        assert_eq!((empty.as_str(), n), ("[]\n", 0));
        let (csv_empty, _) = export(Format::Csv, &cols, &[]);
        assert_eq!(csv_empty, "id,id,id\n");
    }

    #[test]
    fn rows_stream_across_pages() {
        let cols = [col("g", "int4")];
        let pages: Vec<Vec<Vec<Cell>>> = (0..3)
            .map(|p| (0..2).map(|i| vec![s(&(p * 2 + i).to_string())]).collect())
            .collect();
        let (out, n) = export(Format::Csv, &cols, &pages);
        assert_eq!((out.as_str(), n), ("g\n0\n1\n2\n3\n4\n5\n", 6));
    }

    #[test]
    fn json_number_grammar() {
        for ok in ["0", "-0", "12", "1.5", "-1.5e+10", "2E-3"] {
            assert!(is_json_number(ok), "{ok}");
        }
        for bad in [
            "", "-", "01", "1.", ".5", "1e", "NaN", "Infinity", "1_000", "+1",
        ] {
            assert!(!is_json_number(bad), "{bad}");
        }
    }
}
