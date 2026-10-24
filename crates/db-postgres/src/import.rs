//! File import: one COPY in one transaction on a side connection, after the setup statements
//! (such as CREATE TABLE), so the table and its rows appear together or not at all.

use std::pin::Pin;

use bytes::Bytes;
use futures_util::SinkExt;
use quarry_db_core::{DbError, ImportSink, Session, TableName};
use tokio_postgres::CopyInSink;

use crate::sqlutil::quote_ident;
use crate::{PgSession, errors, open};

pub struct PgImport {
    side: PgSession,
    sink: Option<Pin<Box<CopyInSink<Bytes>>>>,
}

pub async fn begin(
    session: &PgSession,
    setup: &[String],
    table: &TableName,
    columns: &[String],
) -> Result<PgImport, DbError> {
    if session.params.read_only {
        return Err(errors::invalid(
            "This data source is read-only: importing into it is not allowed.".into(),
        ));
    }
    if columns.is_empty() {
        return Err(errors::invalid(
            "Choose at least one column to import.".into(),
        ));
    }
    let side = open(&session.params, None).await.map_err(|e| {
        errors::invalid(format!(
            "Could not open a connection for the import: {}",
            e.message
        ))
    })?;
    let total = setup.len();
    let started = side
        .with_client(async |client| {
            client.batch_execute("BEGIN").await?;
            for (i, sql) in setup.iter().enumerate() {
                if let Err(e) = client.batch_execute(sql).await {
                    return Ok(Err((i, e)));
                }
            }
            Ok(Ok(()))
        })
        .await;
    match started {
        Ok(Ok(())) => {}
        Ok(Err((i, e))) => {
            let _ = side
                .with_client(async |c| c.batch_execute("ROLLBACK").await)
                .await;
            side.close().await;
            let mut err = errors::db_error(&e);
            err.message = format!("Statement {} of {total} failed: {}", i + 1, err.message);
            err.hint = Some("Nothing was imported.".into());
            return Err(err);
        }
        Err(e) => {
            side.close().await;
            return Err(e);
        }
    }
    let sql = format!(
        "COPY {}.{} ({}) FROM STDIN",
        quote_ident(&table.schema),
        quote_ident(&table.name),
        columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let sink = side
        .with_client(async |client| client.copy_in::<_, Bytes>(&sql).await)
        .await;
    match sink {
        Ok(sink) => Ok(PgImport {
            side,
            sink: Some(Box::pin(sink)),
        }),
        Err(e) => {
            let _ = side
                .with_client(async |c| c.batch_execute("ROLLBACK").await)
                .await;
            side.close().await;
            Err(e)
        }
    }
}

#[async_trait::async_trait]
impl ImportSink for PgImport {
    async fn write(&mut self, rows: Vec<u8>) -> Result<(), DbError> {
        let sink = self.sink.as_mut().ok_or_else(errors::session_closed)?;
        sink.send(Bytes::from(rows))
            .await
            .map_err(|e| errors::db_error(&e))
    }

    async fn finish(mut self: Box<Self>) -> Result<u64, DbError> {
        let Some(mut sink) = self.sink.take() else {
            return Err(errors::session_closed());
        };
        let finished = sink.as_mut().finish().await;
        let result = match finished {
            Ok(rows) => self
                .side
                .with_client(async |c| c.batch_execute("COMMIT").await)
                .await
                .map(|()| rows),
            Err(e) => {
                let _ = self
                    .side
                    .with_client(async |c| c.batch_execute("ROLLBACK").await)
                    .await;
                Err(errors::db_error(&e))
            }
        };
        self.side.close().await;
        result
    }

    async fn abort(mut self: Box<Self>) {
        // Dropping the sink without finishing it fails the COPY on the server.
        drop(self.sink.take());
        let _ = self
            .side
            .with_client(async |c| c.batch_execute("ROLLBACK").await)
            .await;
        self.side.close().await;
    }
}
