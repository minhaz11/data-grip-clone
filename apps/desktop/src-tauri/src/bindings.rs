//! TypeScript bindings for every type that crosses IPC, generated from the Rust types so the two
//! sides cannot drift, plus a check that the four hand-kept command lists agree.
//!
//! `cargo test` fails when `apps/desktop/src/ipc/bindings.ts` is stale. Regenerate it with
//! `npm run bindings` (which runs this test with `UPDATE_BINDINGS=1`).

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    use ts_rs::{Config, TS};

    const HEADER: &str = "// Generated from the Rust IPC types by src-tauri/src/bindings.rs. Do not edit.\n\
                          // Regenerate with `npm run bindings`.\n";

    fn manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn bindings_path() -> PathBuf {
        manifest_dir().join("../src/ipc/bindings.ts")
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn decl<T: TS>(cfg: &Config) -> String {
        format!("export {}\n", T::decl(cfg))
    }

    /// Every IPC type, grouped as in the UI. Types they reference must be listed too, or the
    /// generated file will not typecheck.
    fn render() -> String {
        // JSON numbers: no value we send exceeds 2^53 (row counts, byte sizes, milliseconds).
        let cfg = Config::new().with_large_int("number");
        let decls = [
            // Settings (quarry-store)
            decl::<quarry_store::ThemePreference>(&cfg),
            decl::<quarry_store::ResultTabs>(&cfg),
            decl::<quarry_store::OutsideStatement>(&cfg),
            decl::<quarry_store::SelectionRun>(&cfg),
            decl::<quarry_store::Settings>(&cfg),
            // AI (quarry-store, quarry-ai-core)
            decl::<quarry_store::AiIgnoreKind>(&cfg),
            decl::<quarry_store::AiIgnoreRule>(&cfg),
            decl::<quarry_store::AiSettings>(&cfg),
            decl::<quarry_ai_core::ModelInfo>(&cfg),
            decl::<quarry_ai_core::StopReason>(&cfg),
            decl::<quarry_ai_core::Usage>(&cfg),
            decl::<crate::ai::AiStatus>(&cfg),
            decl::<crate::ai::AiModels>(&cfg),
            decl::<crate::ai::AiStreamEvent>(&cfg),
            // Errors
            decl::<crate::error::AppError>(&cfg),
            decl::<crate::error::HostKeyPrompt>(&cfg),
            decl::<quarry_db_core::ConnectErrorKind>(&cfg),
            // Connections (quarry-store, quarry-connections)
            decl::<quarry_store::Engine>(&cfg),
            decl::<quarry_store::SslMode>(&cfg),
            decl::<quarry_store::Environment>(&cfg),
            decl::<quarry_store::SaveMode>(&cfg),
            decl::<quarry_store::ConnectionDraft>(&cfg),
            decl::<quarry_store::ConnectionProfile>(&cfg),
            decl::<quarry_connections::PasswordChange>(&cfg),
            decl::<quarry_store::Folder>(&cfg),
            decl::<quarry_store::SshAuthMethod>(&cfg),
            decl::<quarry_store::SshProfileDraft>(&cfg),
            decl::<quarry_store::SshProfile>(&cfg),
            decl::<crate::connections::FilePurpose>(&cfg),
            decl::<crate::connections::SshTest>(&cfg),
            // Sessions
            decl::<quarry_db_core::ServerInfo>(&cfg),
            decl::<crate::sessions::SessionStatus>(&cfg),
            decl::<crate::sessions::StatusEvent>(&cfg),
            decl::<crate::sessions::SessionKey>(&cfg),
            decl::<crate::sessions::SessionState>(&cfg),
            decl::<quarry_db_core::TxStatus>(&cfg),
            decl::<quarry_db_core::TxMode>(&cfg),
            decl::<quarry_db_core::Isolation>(&cfg),
            decl::<quarry_db_core::TxSettings>(&cfg),
            decl::<crate::transactions::QuitResolution>(&cfg),
            // Metadata tree
            decl::<quarry_db_core::ObjectType>(&cfg),
            decl::<quarry_db_core::MetadataRequest>(&cfg),
            decl::<quarry_db_core::MetaKind>(&cfg),
            decl::<quarry_db_core::MetaNode>(&cfg),
            decl::<quarry_db_core::ObjectRef>(&cfg),
            decl::<quarry_db_core::ObjectDetails>(&cfg),
            decl::<quarry_db_core::ColumnDetail>(&cfg),
            decl::<quarry_db_core::IndexDetail>(&cfg),
            decl::<quarry_db_core::ConstraintDetail>(&cfg),
            decl::<quarry_db_core::ForeignKeyDetail>(&cfg),
            decl::<quarry_db_core::TriggerDetail>(&cfg),
            decl::<quarry_db_core::DdlObject>(&cfg),
            decl::<quarry_db_core::DdlOptions>(&cfg),
            decl::<quarry_db_core::Identity>(&cfg),
            decl::<quarry_db_core::FkAction>(&cfg),
            decl::<quarry_db_core::ColumnModel>(&cfg),
            decl::<quarry_db_core::KeyModel>(&cfg),
            decl::<quarry_db_core::CheckModel>(&cfg),
            decl::<quarry_db_core::ForeignKeyModel>(&cfg),
            decl::<quarry_db_core::IndexModel>(&cfg),
            decl::<quarry_db_core::TableModel>(&cfg),
            decl::<quarry_db_core::DropObject>(&cfg),
            decl::<quarry_db_core::RenameObject>(&cfg),
            decl::<quarry_db_core::TableName>(&cfg),
            decl::<quarry_db_core::SchemaChange>(&cfg),
            // Query execution
            decl::<quarry_db_core::ColumnInfo>(&cfg),
            decl::<quarry_db_core::StatementOutcome>(&cfg),
            decl::<crate::exec::StatementError>(&cfg),
            decl::<crate::exec::StatementRequest>(&cfg),
            decl::<crate::exec::ExecRequest>(&cfg),
            decl::<crate::exec::JobStatus>(&cfg),
            decl::<crate::exec::ExecEvent>(&cfg),
            // Query history
            decl::<quarry_store::HistoryStatus>(&cfg),
            decl::<quarry_store::HistoryEntry>(&cfg),
            decl::<quarry_store::HistoryQuery>(&cfg),
            decl::<crate::history::HistoryExportFormat>(&cfg),
            // Snippets
            decl::<quarry_store::SnippetDialect>(&cfg),
            decl::<quarry_store::SnippetDraft>(&cfg),
            decl::<quarry_store::Snippet>(&cfg),
            decl::<quarry_store::SnippetFile>(&cfg),
            decl::<crate::snippets::SnippetImport>(&cfg),
            // Local history of consoles
            decl::<quarry_store::RevisionReason>(&cfg),
            decl::<quarry_store::RevisionInfo>(&cfg),
            // Results: sort/filter, editing, export
            decl::<quarry_db_core::SortKey>(&cfg),
            decl::<quarry_db_core::Filter>(&cfg),
            decl::<quarry_db_core::FilterOp>(&cfg),
            decl::<quarry_db_core::Refinement>(&cfg),
            decl::<quarry_db_core::EditColumn>(&cfg),
            decl::<quarry_db_core::EditTarget>(&cfg),
            decl::<quarry_db_core::Editability>(&cfg),
            decl::<quarry_db_core::ColumnValue>(&cfg),
            decl::<quarry_db_core::RowChange>(&cfg),
            decl::<quarry_db_core::EditStatement>(&cfg),
            decl::<quarry_db_core::Notice>(&cfg),
            decl::<crate::results::ExportFormat>(&cfg),
            decl::<crate::results::ExportColumn>(&cfg),
            decl::<crate::results::ExportSummary>(&cfg),
            decl::<crate::results::ExportOptions>(&cfg),
            decl::<crate::results::CopySummary>(&cfg),
            // Import
            decl::<quarry_io::import::FileKind>(&cfg),
            decl::<quarry_io::import::ImportFormat>(&cfg),
            decl::<quarry_io::import::Detected>(&cfg),
            decl::<quarry_io::import::ErrorPolicy>(&cfg),
            decl::<quarry_io::import::ColumnMapping>(&cfg),
            decl::<quarry_io::import::ImportPlan>(&cfg),
            decl::<quarry_io::import::ImportProgress>(&cfg),
            decl::<quarry_io::import::Rejected>(&cfg),
            decl::<quarry_io::import::ImportSummary>(&cfg),
            decl::<crate::import::ImportFile>(&cfg),
            decl::<crate::import::DroppedFile>(&cfg),
            decl::<crate::import::ImportPreview>(&cfg),
            decl::<crate::import::ImportEvent>(&cfg),
        ];
        format!("{HEADER}\n{}", decls.join("\n"))
    }

    #[test]
    fn bindings_are_current() {
        let path = bindings_path();
        let expected = render();
        if std::env::var_os("UPDATE_BINDINGS").is_some() {
            std::fs::write(&path, &expected).expect("write bindings.ts");
            return;
        }
        let actual = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            actual == expected,
            "{} is stale: run `npm run bindings` and commit the result",
            path.display()
        );
    }

    /// Quoted names in build.rs's `commands` array.
    fn build_rs_commands() -> BTreeSet<String> {
        let text = read(&manifest_dir().join("build.rs"));
        text.lines()
            .map(str::trim)
            .filter_map(|l| l.strip_prefix('"')?.strip_suffix("\","))
            .map(str::to_owned)
            .collect()
    }

    /// `allow-x-y` permissions in the capability file, as `x_y`.
    fn capability_commands() -> BTreeSet<String> {
        let text = read(&manifest_dir().join("capabilities/default.json"));
        let json: serde_json::Value = serde_json::from_str(&text).expect("capability JSON");
        json["permissions"]
            .as_array()
            .expect("permissions array")
            .iter()
            .filter_map(|p| p.as_str()?.strip_prefix("allow-"))
            .map(|p| p.replace('-', "_"))
            .collect()
    }

    /// `module::name` entries inside `generate_handler![...]` in lib.rs.
    fn handler_commands() -> BTreeSet<String> {
        let text = read(&manifest_dir().join("src/lib.rs"));
        let start = text
            .find("generate_handler![")
            .expect("generate_handler! in lib.rs");
        let body = &text[start..];
        let body = &body[..body.find(']').expect("end of generate_handler!")];
        body.split(',')
            .filter_map(|item| {
                item.trim()
                    .rsplit_once("::")
                    .map(|(_, name)| name.to_owned())
            })
            .collect()
    }

    /// Names passed to `invoke(...)` in the UI's IPC client.
    fn client_commands() -> BTreeSet<String> {
        let text = read(&manifest_dir().join("../src/ipc/client.ts"));
        text.match_indices("invoke")
            .filter_map(|(at, _)| {
                let rest = &text[at..];
                let open = rest.find('(')?;
                let rest = rest[open + 1..].strip_prefix('\'')?;
                Some(rest[..rest.find('\'')?].to_owned())
            })
            .collect()
    }

    #[test]
    fn command_lists_agree() {
        let built = build_rs_commands();
        assert!(!built.is_empty(), "no commands found in build.rs");
        assert_eq!(
            capability_commands(),
            built,
            "capabilities/default.json vs build.rs"
        );
        assert_eq!(
            handler_commands(),
            built,
            "generate_handler! in lib.rs vs build.rs"
        );
        assert_eq!(
            client_commands(),
            built,
            "invoke() names in ipc/client.ts vs build.rs"
        );
    }
}
