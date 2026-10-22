fn main() {
    // Every IPC command must be listed here; capabilities/default.json then grants them explicitly.
    // Anything not listed is unreachable from the WebView.
    let commands = &[
        "settings_get",
        "settings_set",
        "workspace_get",
        "workspace_set",
        "connections_list",
        "connection_create",
        "connection_update",
        "connection_duplicate",
        "connection_delete",
        "connection_test",
        "connection_connect",
        "connection_disconnect",
        "sessions_list",
        "metadata_children",
        "console_list",
        "console_create",
        "console_read",
        "console_write",
        "query_execute",
        "query_cancel",
        "result_page",
        "result_close",
        "result_export",
        "result_refine",
        "result_preview_edits",
        "result_apply_edits",
        "session_state",
        "session_set_tx",
        "tx_commit",
        "tx_rollback",
        "session_close",
        "session_drop",
        "app_quit",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
