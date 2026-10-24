//! IPC for file-backed consoles. Consoles are addressed by name; the backend owns the directory.
//! Saves keep a local history (M5.2): the text a save replaces is kept as a revision when the
//! policy in `quarry_store::revisions` says so.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex};

use quarry_store::revisions::before_save;
use quarry_store::{RevisionInfo, RevisionReason};
use quarry_workspace::{ConsoleError, Consoles};
use tauri::State;

use crate::error::AppError;
use crate::exec::unix_millis;

type Store<'a> = State<'a, Arc<Consoles>>;
type AppStore<'a> = State<'a, Arc<quarry_store::Store>>;
type Written<'a> = State<'a, Arc<LastWritten>>;

/// A hash of the text each console had when this app last read or wrote it, so a save can tell
/// that the file was changed outside the app meanwhile.
#[derive(Default)]
pub struct LastWritten(Mutex<HashMap<String, u64>>);

fn hash(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

impl LastWritten {
    fn set(&self, name: &str, text: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(name.to_owned(), hash(text));
    }

    /// True when the app knows what it last wrote and the file now holds something else.
    fn changed_outside(&self, name: &str, on_disk: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(name)
            .is_some_and(|h| *h != hash(on_disk))
    }

    fn rename(&self, from: &str, to: &str) {
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(h) = map.remove(from) {
            map.insert(to.to_owned(), h);
        }
    }
}

async fn run<T, F>(consoles: &Arc<Consoles>, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Consoles) -> Result<T, ConsoleError> + Send + 'static,
{
    let consoles = Arc::clone(consoles);
    tauri::async_runtime::spawn_blocking(move || f(&consoles))
        .await
        .map_err(|e| AppError::new("internal", format!("console task failed: {e}")))?
        .map_err(AppError::from)
}

/// Like `run`, for work that also touches app.db.
async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::new("internal", format!("console task failed: {e}")))?
}

/// Records `text` as a revision of `name` (blank text and repeats are skipped).
fn snapshot(
    store: &quarry_store::Store,
    name: &str,
    reason: RevisionReason,
    text: &str,
) -> Result<(), AppError> {
    let retention = store.settings()?.revision_retention();
    store.add_revision(name, reason, text, unix_millis(), retention)?;
    Ok(())
}

#[tauri::command]
pub async fn console_list(consoles: Store<'_>) -> Result<Vec<String>, AppError> {
    run(&consoles, |c| c.list()).await
}

/// Returns the new console's name (`preferred` when it is free and valid).
#[tauri::command]
pub async fn console_create(
    consoles: Store<'_>,
    preferred: Option<String>,
) -> Result<String, AppError> {
    run(&consoles, move |c| c.create(preferred.as_deref())).await
}

#[tauri::command]
pub async fn console_read(
    consoles: Store<'_>,
    written: Written<'_>,
    name: String,
) -> Result<String, AppError> {
    let written = Arc::clone(&written);
    run(&consoles, move |c| {
        let text = c.read(&name)?;
        written.set(&name, &text);
        Ok(text)
    })
    .await
}

/// Renames a console file; fails if `new_name` is taken. Its local history moves along.
#[tauri::command]
pub async fn console_rename(
    consoles: Store<'_>,
    store: AppStore<'_>,
    written: Written<'_>,
    name: String,
    new_name: String,
) -> Result<(), AppError> {
    let (consoles, store, written) = (
        Arc::clone(&consoles),
        Arc::clone(&store),
        Arc::clone(&written),
    );
    blocking(move || {
        consoles.rename(&name, &new_name)?;
        store.rename_revisions(&name, &new_name)?;
        written.rename(&name, &new_name);
        Ok(())
    })
    .await
}

/// Copies a console; returns the copy's name.
#[tauri::command]
pub async fn console_duplicate(consoles: Store<'_>, name: String) -> Result<String, AppError> {
    run(&consoles, move |c| c.duplicate(&name)).await
}

/// Deletes a console file (only regular files inside the consoles directory). Its last text is
/// kept in the local history first.
#[tauri::command]
pub async fn console_delete(
    consoles: Store<'_>,
    store: AppStore<'_>,
    name: String,
) -> Result<(), AppError> {
    let (consoles, store) = (Arc::clone(&consoles), Arc::clone(&store));
    blocking(move || {
        let text = consoles.read(&name)?;
        snapshot(&store, &name, RevisionReason::BeforeDelete, &text)?;
        consoles.delete(&name)?;
        Ok(())
    })
    .await
}

/// Where console files live, for tab tooltips.
#[tauri::command]
pub async fn consoles_dir(consoles: Store<'_>) -> Result<String, AppError> {
    Ok(consoles.dir().display().to_string())
}

#[tauri::command]
pub async fn console_write(
    consoles: Store<'_>,
    store: AppStore<'_>,
    written: Written<'_>,
    name: String,
    text: String,
) -> Result<(), AppError> {
    let (consoles, store, written) = (
        Arc::clone(&consoles),
        Arc::clone(&store),
        Arc::clone(&written),
    );
    blocking(move || save_with_history(&consoles, &store, &written, &name, &text, unix_millis()))
        .await
}

/// Writes a console, first keeping the text it replaces when the local history policy asks.
fn save_with_history(
    consoles: &Consoles,
    store: &quarry_store::Store,
    written: &LastWritten,
    name: &str,
    text: &str,
    now: i64,
) -> Result<(), AppError> {
    let previous = match consoles.read(name) {
        Ok(previous) => Some(previous),
        Err(ConsoleError::NotFound(_)) => None,
        Err(e) => return Err(e.into()),
    };
    if let Some(previous) = previous {
        let external = written.changed_outside(name, &previous);
        let retention = store.settings()?.revision_retention();
        if let Some(reason) = before_save(
            &previous,
            text,
            external,
            store.latest_revision_at(name)?,
            now,
            retention.interval_ms,
        ) {
            store.add_revision(name, reason, &previous, now, retention)?;
        }
    }
    consoles.write(name, text)?;
    written.set(name, text);
    Ok(())
}

/// Keeps the console's current file text as a revision (before a run or a format).
#[tauri::command]
pub async fn console_checkpoint(
    consoles: Store<'_>,
    store: AppStore<'_>,
    name: String,
    reason: RevisionReason,
) -> Result<(), AppError> {
    let (consoles, store) = (Arc::clone(&consoles), Arc::clone(&store));
    blocking(move || {
        let text = consoles.read(&name)?;
        snapshot(&store, &name, reason, &text)
    })
    .await
}

/// The local history of a console, newest first.
#[tauri::command]
pub async fn revisions_list(
    store: AppStore<'_>,
    name: String,
) -> Result<Vec<RevisionInfo>, AppError> {
    let store = Arc::clone(&store);
    blocking(move || Ok(store.list_revisions(&name)?)).await
}

#[tauri::command]
pub async fn revision_read(store: AppStore<'_>, id: i64) -> Result<String, AppError> {
    let store = Arc::clone(&store);
    blocking(move || {
        store
            .revision(id)?
            .map(|(_, text)| text)
            .ok_or_else(|| AppError::new("not_found", "That revision is no longer kept."))
    })
    .await
}

/// Puts a revision's text back into its console file, keeping the replaced text as a revision
/// first (so a restore can itself be undone). Returns the restored text.
#[tauri::command]
pub async fn revision_restore(
    consoles: Store<'_>,
    store: AppStore<'_>,
    written: Written<'_>,
    id: i64,
) -> Result<String, AppError> {
    let (consoles, store, written) = (
        Arc::clone(&consoles),
        Arc::clone(&store),
        Arc::clone(&written),
    );
    blocking(move || {
        let (name, text) = store
            .revision(id)?
            .ok_or_else(|| AppError::new("not_found", "That revision is no longer kept."))?;
        let current = consoles.read(&name)?;
        snapshot(&store, &name, RevisionReason::BeforeRestore, &current)?;
        consoles.write(&name, &text)?;
        written.set(&name, &text);
        tracing::info!(console = %name, revision = id, "console restored from local history");
        Ok(text)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_text_and_outside_changes_stay_in_the_history() {
        let dir = tempfile::tempdir().expect("tempdir");
        let consoles = Consoles::new(dir.path().join("consoles"));
        let store = quarry_store::Store::open_in_memory().expect("store");
        let written = LastWritten::default();
        let name = consoles.create(Some("q")).expect("create");
        let save = |text: &str, now: i64| {
            save_with_history(&consoles, &store, &written, &name, text, now).expect("save")
        };

        // Typing: a burst of autosaves.
        let mut text = String::new();
        for (i, c) in "select * from orders where id = 42".chars().enumerate() {
            text.push(c);
            save(&text, 1_000 + i as i64 * 400);
        }
        // Everything deleted and saved within the same minute.
        save("", 20_000);
        let revisions = store.list_revisions(&name).expect("list");
        assert_eq!(revisions[0].reason, RevisionReason::BeforeDeletion);
        assert_eq!(
            store
                .revision(revisions[0].id)
                .expect("read")
                .map(|(_, t)| t),
            Some("select * from orders where id = 42".into())
        );
        // Few revisions for many saves.
        assert!(revisions.len() <= 2, "{revisions:?}");

        // Changed in another editor: kept before Quarry overwrites it.
        save("select 1", 30_000);
        std::fs::write(
            dir.path().join("consoles/q.sql"),
            "select 2 -- edited elsewhere",
        )
        .expect("outside");
        save("select 3", 31_000);
        let latest = &store.list_revisions(&name).expect("list")[0];
        assert_eq!(latest.reason, RevisionReason::External);
        assert_eq!(latest.first_line, "select 2 -- edited elsewhere");
    }
}
