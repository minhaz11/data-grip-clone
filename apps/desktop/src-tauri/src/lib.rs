mod bindings;
mod commands;
mod connections;
mod consoles;
mod error;
mod exec;
mod results;
mod sessions;
mod transactions;

use std::sync::Arc;

use quarry_connections::ConnectionManager;
use quarry_db_postgres::PostgresAdapter;
use quarry_secrets::KeyringStore;
use quarry_store::Store;
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        // Used from Rust only (export save dialog); the WebView gets no dialog permissions.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Redacting, size-capped log file (ADR-0003); also stderr in development builds.
            quarry_logging::init(&app.path().app_log_dir()?, cfg!(debug_assertions))?;
            tracing::info!(version = %app.package_info().version, "Quarry starting");
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Arc::new(Store::open(&dir.join("app.db"))?);
            // Keyring entries are namespaced by the app identifier (ADR-0003).
            let keyring = Arc::new(KeyringStore::new(app.config().identifier.clone()));
            app.manage(Arc::new(ConnectionManager::new(
                Arc::clone(&store),
                keyring,
            )));
            app.manage(Arc::new(quarry_workspace::Consoles::new(
                dir.join("consoles"),
            )));
            app.manage(store);
            app.manage(Arc::new(exec::Jobs::default()));
            app.manage(Arc::new(sessions::Sessions::new(Arc::new(PostgresAdapter))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get,
            commands::settings_set,
            commands::workspace_get,
            commands::workspace_set,
            connections::connections_list,
            connections::connection_create,
            connections::connection_update,
            connections::connection_duplicate,
            connections::connection_delete,
            connections::connection_test,
            connections::connection_connect,
            connections::connection_disconnect,
            connections::sessions_list,
            connections::metadata_children,
            connections::object_details,
            consoles::console_list,
            consoles::console_create,
            consoles::console_read,
            consoles::console_write,
            exec::query_execute,
            exec::query_cancel,
            results::result_page,
            results::result_close,
            results::result_refine,
            results::result_preview_edits,
            results::result_apply_edits,
            results::result_export,
            transactions::session_state,
            transactions::session_set_tx,
            transactions::tx_commit,
            transactions::tx_rollback,
            transactions::session_close,
            transactions::session_drop,
            transactions::app_quit,
        ])
        // Never lose an open transaction silently: ask the UI first (REQ-ERR-09).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let open = window
                    .state::<Arc<sessions::Sessions>>()
                    .open_transactions();
                if !open.is_empty() {
                    api.prevent_close();
                    let _ = window.emit(transactions::QUIT_REQUESTED_EVENT, open);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Quarry");
}
