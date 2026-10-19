mod commands;
mod connections;
mod error;

use std::sync::Arc;

use quarry_connections::ConnectionManager;
use quarry_secrets::KeyringStore;
use quarry_store::Store;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Arc::new(Store::open(&dir.join("app.db"))?);
            // Keyring entries are namespaced by the app identifier (ADR-0003).
            let keyring = Arc::new(KeyringStore::new(app.config().identifier.clone()));
            app.manage(Arc::new(ConnectionManager::new(
                Arc::clone(&store),
                keyring,
            )));
            app.manage(store);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quarry");
}
