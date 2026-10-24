//! IPC surface for transactions and console sessions (M4.6): mode, Commit/Rollback, closing and
//! dropping sessions, and resolving open transactions before the app quits.

use std::sync::Arc;

use quarry_db_core::TxSettings;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::sessions::{SessionKey, SessionState, Sessions};

type Live<'a> = State<'a, Arc<Sessions>>;

/// Sent when the user closes the window while transactions are open; the UI asks what to do and
/// answers with `app_quit`.
pub const QUIT_REQUESTED_EVENT: &str = "quit-requested";

#[tauri::command]
pub async fn session_state(
    sessions: Live<'_>,
    session: SessionKey,
) -> Result<SessionState, AppError> {
    Ok(sessions.state(&session).await)
}

#[tauri::command]
pub async fn session_set_tx(
    app: AppHandle,
    sessions: Live<'_>,
    session: SessionKey,
    settings: TxSettings,
) -> Result<SessionState, AppError> {
    Ok(sessions.set_tx_settings(&app, &session, settings).await)
}

#[tauri::command]
pub async fn tx_commit(
    app: AppHandle,
    sessions: Live<'_>,
    session: SessionKey,
) -> Result<SessionState, AppError> {
    sessions.commit(&app, &session).await
}

#[tauri::command]
pub async fn tx_rollback(
    app: AppHandle,
    sessions: Live<'_>,
    session: SessionKey,
) -> Result<SessionState, AppError> {
    sessions.rollback(&app, &session).await
}

/// Closes a console's own session (its console was closed or switched to the shared session).
#[tauri::command]
pub async fn session_close(sessions: Live<'_>, session: SessionKey) -> Result<(), AppError> {
    sessions.close_console(&session).await
}

/// Second-stage cancel: drops the connection even though a statement is still running.
#[tauri::command]
pub async fn session_drop(
    app: AppHandle,
    sessions: Live<'_>,
    session: SessionKey,
) -> Result<(), AppError> {
    sessions.drop_session(&app, &session).await;
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum QuitResolution {
    Commit,
    Rollback,
}

/// Commits or rolls back every open transaction, then exits. If any commit fails, nothing exits
/// and the error says which session it was.
#[tauri::command]
pub async fn app_quit(
    app: AppHandle,
    sessions: Live<'_>,
    resolution: QuitResolution,
) -> Result<(), AppError> {
    for key in sessions.open_transactions() {
        let result = match resolution {
            QuitResolution::Commit => sessions.commit(&app, &key).await,
            QuitResolution::Rollback => sessions.rollback(&app, &key).await,
        };
        if let Err(e) = result {
            return Err(AppError {
                message: format!(
                    "{} (data source {}{}). The app was not closed.",
                    e.message,
                    key.source_id,
                    key.console
                        .as_deref()
                        .map(|c| format!(", console {c}"))
                        .unwrap_or_default()
                ),
                ..e
            });
        }
    }
    tracing::info!(?resolution, "quitting after resolving open transactions");
    app.exit(0);
    Ok(())
}
