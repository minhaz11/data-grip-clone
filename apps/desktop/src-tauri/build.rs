fn main() {
    // Every IPC command must be listed here; capabilities/default.json then grants them explicitly.
    // Anything not listed is unreachable from the WebView.
    let commands = &[
        "settings_get",
        "settings_set",
        "workspace_get",
        "workspace_set",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
