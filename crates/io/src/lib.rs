//! Streaming result export and copy (module H). Rows are written page by page, so exports of
//! any size use constant memory; values arrive in the server's text form and are written without
//! loss. Copy and export share one writer per format.

use std::collections::HashMap;
use std::io::{self, Write};

use quarry_db_core::{Cell, ColumnInfo, TableName};

mod stream;

pub use stream::{
    CopyOutcome, ExportOutcome, StreamError, copy_to_string, export_to_file, partial_path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// RFC 4180 style, `,`-separated, `\n` records, header row. NULL is an empty unquoted field and
    /// an empty string is `""`, so the two stay distinguishable (as with PostgreSQL `COPY … CSV`).
    Csv,
    /// The CSV rules with a tab delimiter (what spreadsheets paste).
    Tsv,
    /// A JSON array of objects keyed by column name.
    Json,
    /// One `INSERT` statement per row, runnable as is.
    SqlInsert,
    /// A GitHub-flavored Markdown table.
    Markdown,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Tsv => "tsv",
            Format::Json => "json",
            Format::SqlInsert => "sql",
            Format::Markdown => "md",
        }
    }
}

/// How values are written. JSON ignores every option; SQL uses only `table`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteOptions {
    /// Text for NULL. Absent: empty for CSV/TSV, `NULL` for Markdown.
    pub null_text: Option<String>,
    /// CSV/TSV: quote every non-NULL value, not only those that need it.
    pub quote_all: bool,
    /// CSV/TSV/Markdown: start with a header row of column names.
    pub header: bool,
    /// SQL INSERT: the table to insert into. Absent: the placeholder `result_table`.
    pub table: Option<TableName>,
}

impl Default for WriteOptions {
    fn default() -> Self {
        Self {
            null_text: None,
            quote_all: false,
            header: true,
            table: None,
        }
    }
}

/// The placeholder table name for SQL INSERT when the result has no single source table.
pub const PLACEHOLDER_TABLE: &str = "result_table";

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
    options: WriteOptions,
    /// JSON object keys (made unique) and how each column is encoded.
    keys: Vec<String>,
    kinds: Vec<Kind>,
    /// SQL INSERT: everything before the values, e.g. `INSERT INTO "s"."t" ("a") VALUES (`.
    insert_prefix: String,
    rows: u64,
}

impl<W: Write> ExportWriter<W> {
    pub fn new(
        mut out: W,
        format: Format,
        columns: &[ColumnInfo],
        options: &WriteOptions,
    ) -> io::Result<Self> {
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
        let header: Vec<Cell> = columns.iter().map(|c| Some(c.name.clone())).collect();
        let mut insert_prefix = String::new();
        match format {
            Format::Csv | Format::Tsv => {
                if options.header {
                    write_delimited(&mut out, &header, delimiter(format), options)?;
                }
            }
            Format::Json => out.write_all(b"[")?,
            Format::SqlInsert => {
                let table = match &options.table {
                    Some(t) => format!("{}.{}", quote_ident(&t.schema), quote_ident(&t.name)),
                    None => PLACEHOLDER_TABLE.to_owned(),
                };
                let names: Vec<String> = columns.iter().map(|c| quote_ident(&c.name)).collect();
                insert_prefix = format!("INSERT INTO {table} ({}) VALUES (", names.join(", "));
            }
            Format::Markdown => {
                if options.header {
                    write_markdown_row(&mut out, &header, "")?;
                    out.write_all(b"|")?;
                    for c in columns {
                        let numeric = c.type_name.as_deref().is_some_and(|t| NUMERIC.contains(&t));
                        out.write_all(if numeric { b" ---: |" } else { b" --- |" })?;
                    }
                    out.write_all(b"\n")?;
                }
            }
        }
        Ok(Self {
            out,
            format,
            options: options.clone(),
            keys,
            kinds,
            insert_prefix,
            rows: 0,
        })
    }

    pub fn write_rows(&mut self, rows: &[Vec<Cell>]) -> io::Result<()> {
        for row in rows {
            match self.format {
                Format::Csv | Format::Tsv => {
                    write_delimited(&mut self.out, row, delimiter(self.format), &self.options)?;
                }
                Format::SqlInsert => {
                    self.out.write_all(self.insert_prefix.as_bytes())?;
                    for (i, cell) in row.iter().enumerate() {
                        if i > 0 {
                            self.out.write_all(b", ")?;
                        }
                        write_sql_value(
                            &mut self.out,
                            cell.as_deref(),
                            self.kinds.get(i).copied().unwrap_or(Kind::Text),
                        )?;
                    }
                    self.out.write_all(b");\n")?;
                }
                Format::Markdown => {
                    let null = self.options.null_text.as_deref().unwrap_or("NULL");
                    write_markdown_row(&mut self.out, row, null)?;
                }
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

fn delimiter(format: Format) -> char {
    if format == Format::Tsv { '\t' } else { ',' }
}

fn write_delimited(
    out: &mut impl Write,
    cells: &[Cell],
    delimiter: char,
    options: &WriteOptions,
) -> io::Result<()> {
    let mut buf = [0u8; 4];
    let delimiter_bytes = delimiter.encode_utf8(&mut buf).as_bytes().to_vec();
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            out.write_all(&delimiter_bytes)?;
        }
        match cell {
            // NULL: the NULL text unquoted (empty by default), so it differs from `""`.
            None => out.write_all(options.null_text.as_deref().unwrap_or("").as_bytes())?,
            Some(v) => {
                let quote = options.quote_all
                    || v.is_empty()
                    || v.contains([delimiter, '"', '\n', '\r'])
                    || v.starts_with(char::is_whitespace)
                    || v.ends_with(char::is_whitespace)
                    || options.null_text.as_deref() == Some(v.as_str());
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

/// A Markdown table row; `|` is escaped and line breaks become `<br>`.
fn write_markdown_row(out: &mut impl Write, cells: &[Cell], null: &str) -> io::Result<()> {
    out.write_all(b"|")?;
    for cell in cells {
        let text = cell.as_deref().unwrap_or(null);
        let escaped = text
            .replace('\\', "\\\\")
            .replace('|', "\\|")
            .replace("\r\n", "<br>")
            .replace(['\n', '\r'], "<br>");
        out.write_all(b" ")?;
        out.write_all(escaped.as_bytes())?;
        out.write_all(b" |")?;
    }
    out.write_all(b"\n")
}

/// A double-quoted SQL identifier.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// A SQL literal: numbers and booleans as such, everything else as a string literal the server
/// casts to the column type.
fn write_sql_value(out: &mut impl Write, value: Option<&str>, kind: Kind) -> io::Result<()> {
    let Some(v) = value else {
        return out.write_all(b"NULL");
    };
    match kind {
        Kind::Number if is_json_number(v) => out.write_all(v.as_bytes()),
        Kind::Bool if v == "t" || v == "f" => {
            out.write_all(if v == "t" { b"TRUE" } else { b"FALSE" })
        }
        _ => {
            out.write_all(b"'")?;
            out.write_all(v.replace('\'', "''").as_bytes())?;
            out.write_all(b"'")
        }
    }
}

/// Formats whole rows at once (copying a selection the UI holds).
pub fn format_rows(
    format: Format,
    columns: &[ColumnInfo],
    rows: &[Vec<Cell>],
    options: &WriteOptions,
) -> io::Result<String> {
    let mut w = ExportWriter::new(Vec::new(), format, columns, options)?;
    w.write_rows(rows)?;
    let (bytes, _) = w.finish()?;
    String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
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
        export_with(format, columns, pages, &WriteOptions::default())
    }

    fn export_with(
        format: Format,
        columns: &[ColumnInfo],
        pages: &[Vec<Vec<Cell>>],
        options: &WriteOptions,
    ) -> (String, u64) {
        let mut w = ExportWriter::new(Vec::new(), format, columns, options).expect("new");
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

    fn opts() -> WriteOptions {
        WriteOptions::default()
    }

    #[test]
    fn tsv_escapes_tabs_quotes_newlines_and_null() {
        let cols = [col("id", "int4"), col("note", "text")];
        let page = vec![
            vec![s("1"), s("a\tb")],
            vec![s("2"), s("a,b")],
            vec![s("3"), s("say \"hi\"\nbye")],
            vec![s("4"), None],
            vec![s("5"), s("")],
        ];
        let (out, _) = export(Format::Tsv, &cols, std::slice::from_ref(&page));
        assert_eq!(
            out,
            "id\tnote\n1\t\"a\tb\"\n2\ta,b\n3\t\"say \"\"hi\"\"\nbye\"\n4\t\n5\t\"\"\n"
        );
        // NULL text, quoting every value, no header.
        let (out, _) = export_with(
            Format::Tsv,
            &cols,
            &[page],
            &WriteOptions {
                null_text: Some("\\N".into()),
                quote_all: true,
                header: false,
                ..opts()
            },
        );
        assert_eq!(
            out,
            "\"1\"\t\"a\tb\"\n\"2\"\t\"a,b\"\n\"3\"\t\"say \"\"hi\"\"\nbye\"\n\"4\"\t\\N\n\"5\"\t\"\"\n"
        );
    }

    #[test]
    fn csv_quotes_a_value_equal_to_the_null_text() {
        let cols = [col("v", "text")];
        let (out, _) = export_with(
            Format::Csv,
            &cols,
            &[vec![vec![s("NULL")], vec![None]]],
            &WriteOptions {
                null_text: Some("NULL".into()),
                ..opts()
            },
        );
        assert_eq!(out, "v\n\"NULL\"\nNULL\n");
    }

    #[test]
    fn sql_insert_quotes_names_and_literals() {
        let cols = [
            col("id", "int8"),
            col("Note", "text"),
            col("ok", "bool"),
            col("x\"y", "numeric"),
        ];
        let page = vec![
            vec![s("1"), s("it's"), s("t"), s("NaN")],
            vec![s("2"), None, s("f"), s("-1.5e3")],
            vec![s("3"), s(""), None, s("10")],
        ];
        let (out, n) = export_with(
            Format::SqlInsert,
            &cols,
            std::slice::from_ref(&page),
            &WriteOptions {
                table: Some(TableName {
                    schema: "shop".into(),
                    name: "Orders".into(),
                }),
                ..opts()
            },
        );
        assert_eq!(n, 3);
        assert_eq!(
            out,
            "INSERT INTO \"shop\".\"Orders\" (\"id\", \"Note\", \"ok\", \"x\"\"y\") VALUES (1, 'it''s', TRUE, 'NaN');\n\
             INSERT INTO \"shop\".\"Orders\" (\"id\", \"Note\", \"ok\", \"x\"\"y\") VALUES (2, NULL, FALSE, -1.5e3);\n\
             INSERT INTO \"shop\".\"Orders\" (\"id\", \"Note\", \"ok\", \"x\"\"y\") VALUES (3, '', NULL, 10);\n"
        );
        let (placeholder, _) = export(Format::SqlInsert, &cols[..1], &[vec![vec![s("1")]]]);
        assert_eq!(
            placeholder,
            "INSERT INTO result_table (\"id\") VALUES (1);\n"
        );
    }

    #[test]
    fn markdown_escapes_pipes_and_line_breaks() {
        let cols = [col("id", "int4"), col("note", "text")];
        let page = vec![
            vec![s("1"), s("a|b")],
            vec![s("2"), s("line1\nline2\r\nline3")],
            vec![s("3"), None],
            vec![s("4"), s("back\\slash")],
        ];
        let (out, _) = export(Format::Markdown, &cols, std::slice::from_ref(&page));
        assert_eq!(
            out,
            "| id | note |\n| ---: | --- |\n| 1 | a\\|b |\n| 2 | line1<br>line2<br>line3 |\n| 3 | NULL |\n| 4 | back\\\\slash |\n"
        );
        let (out, _) = export_with(
            Format::Markdown,
            &cols,
            &[page[2..3].to_vec()],
            &WriteOptions {
                null_text: Some(String::new()),
                header: false,
                ..opts()
            },
        );
        assert_eq!(out, "| 3 |  |\n");
    }

    #[test]
    fn format_rows_matches_streaming() {
        let cols = [col("id", "int4"), col("note", "text")];
        let rows = vec![vec![s("1"), s("a,b")], vec![s("2"), None]];
        for format in [
            Format::Csv,
            Format::Tsv,
            Format::Json,
            Format::SqlInsert,
            Format::Markdown,
        ] {
            let text = format_rows(format, &cols, &rows, &opts()).expect("format");
            assert_eq!(
                text,
                export(format, &cols, std::slice::from_ref(&rows)).0,
                "{format:?}"
            );
        }
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
