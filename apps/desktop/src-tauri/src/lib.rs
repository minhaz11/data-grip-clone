mod commands;
mod error;

use std::sync::Arc;

use quarry_store::Store;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("app.db"))?;
            app.manage(Arc::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get,
            commands::settings_set,
            commands::workspace_get,
            commands::workspace_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quarry");
}
