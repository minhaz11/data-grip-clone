//! IPC surface for schema changes made through forms (M4.5).

use std::sync::Arc;

use quarry_db_core::{SchemaChange, TableModel};
use tauri::State;

use crate::error::AppError;
use crate::sessions::{SessionKey, Sessions};

type Live<'a> = State<'a, Arc<Sessions>>;

/// The editable model of a table for Modify Table; `None` if it no longer exists.
#[tauri::command]
pub async fn table_model(
    sessions: Live<'_>,
    id: String,
    schema: String,
    name: String,
) -> Result<Option<TableModel>, AppError> {
    Ok(sessions
        .get(&SessionKey::shared(&id))
        .await?
        .table_model(&schema, &name)
        .await?)
}

/// The exact statements a change would run; the dialog shows them before anything is applied.
#[tauri::command]
pub async fn schema_preview(
    sessions: Live<'_>,
    change: SchemaChange,
) -> Result<Vec<String>, AppError> {
    sessions.preview_schema(&change)
}

/// Runs the statements (as previewed, or as edited by hand) in one transaction on a separate
/// connection; the first failure rolls everything back.
#[tauri::command]
pub async fn schema_apply(
    sessions: Live<'_>,
    id: String,
    statements: Vec<String>,
) -> Result<(), AppError> {
    let live = sessions.get(&SessionKey::shared(&id)).await?;
    match live.apply_schema(&statements).await {
        Ok(()) => {
            tracing::info!(source = %id, statements = statements.len(), "schema change applied");
            Ok(())
        }
        Err(e) => {
            tracing::warn!(
                source = %id,
                sqlstate = e.sqlstate.as_deref().unwrap_or(""),
                "schema change rolled back"
            );
            Err(e.into())
        }
    }
}
