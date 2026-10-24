mod bindings;
mod commands;
mod connections;
mod consoles;
mod ddl;
mod error;
mod exec;
mod history;
mod import;
mod results;
mod schema;
mod sessions;
mod transactions;
mod tunnels;

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
        // Used from Rust only (whole-result copy); the WebView gets no clipboard permissions.
        .plugin(tauri_plugin_clipboard_manager::init())
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
            app.manage(Arc::new(tunnels::Tunnels::new(Arc::clone(&store))));
            app.manage(Arc::new(quarry_workspace::Consoles::new(
                dir.join("consoles"),
            )));
            app.manage(Arc::new(consoles::LastWritten::default()));
            app.manage(store);
            app.manage(Arc::new(exec::Jobs::default()));
            app.manage(Arc::new(results::Exports::default()));
            app.manage(Arc::new(import::Imports::default()));
            let sessions = Arc::new(sessions::Sessions::new(Arc::new(PostgresAdapter)));
            app.manage(Arc::clone(&sessions));
            // Auto-disconnect (per data source): checked twice a minute.
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    sessions.disconnect_idle(std::time::Instant::now()).await;
                }
            });
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
            connections::connection_rename,
            connections::connection_move,
            connections::connection_schemas,
            connections::folders_list,
            connections::folder_create,
            connections::folder_update,
            connections::folder_delete,
            connections::ssh_profiles_list,
            connections::ssh_profile_create,
            connections::ssh_profile_update,
            connections::ssh_profile_delete,
            connections::ssh_host_trust,
            connections::file_pick,
            connections::sessions_list,
            connections::metadata_children,
            connections::object_details,
            connections::metadata_cancel,
            ddl::ddl_generate,
            ddl::ddl_save,
            schema::table_model,
            schema::schema_preview,
            schema::schema_apply,
            consoles::console_list,
            consoles::console_create,
            consoles::console_read,
            consoles::console_write,
            consoles::console_rename,
            consoles::console_duplicate,
            consoles::console_delete,
            consoles::consoles_dir,
            consoles::console_checkpoint,
            consoles::revisions_list,
            consoles::revision_read,
            consoles::revision_restore,
            exec::query_execute,
            exec::query_cancel,
            history::history_search,
            history::history_delete,
            history::history_clear,
            history::history_export,
            import::import_pick,
            import::import_preview,
            import::import_run,
            import::import_cancel,
            import::import_errors_save,
            results::result_page,
            results::result_close,
            results::result_refine,
            results::result_preview_edits,
            results::result_apply_edits,
            results::result_export,
            results::result_copy,
            results::result_export_cancel,
            results::result_format,
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
            // Files dropped on the window: Rust keeps the paths, the UI gets ids (M5.4).
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) =
                event
            {
                let scale = window.scale_factor().unwrap_or(1.0);
                import::on_drop(
                    window.app_handle(),
                    paths,
                    position.x / scale,
                    position.y / scale,
                );
            }
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
