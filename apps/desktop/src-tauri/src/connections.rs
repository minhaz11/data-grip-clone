//! IPC surface of the connection manager. Passwords may be sent *in*; nothing here returns one.

use std::sync::Arc;

use quarry_connections::{ConnectionError, ConnectionManager, PasswordChange};
use quarry_secrets::SecretString;
use quarry_store::{ConnectionDraft, ConnectionProfile, Folder, SshProfile, SshProfileDraft};
use serde::Deserialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::tunnels::Tunnels;

type Manager<'a> = State<'a, Arc<ConnectionManager>>;

/// Keyring and SQLite calls block (D-Bus, disk); keep them off the main thread.
async fn run<T, F>(manager: &Arc<ConnectionManager>, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&ConnectionManager) -> Result<T, ConnectionError> + Send + 'static,
{
    let manager = Arc::clone(manager);
    tauri::async_runtime::spawn_blocking(move || f(&manager))
        .await
        .map_err(|e| AppError::new("internal", format!("task failed: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn connections_list(manager: Manager<'_>) -> Result<Vec<ConnectionProfile>, AppError> {
    run(&manager, |m| m.list()).await
}

#[tauri::command]
pub async fn connection_create(
    manager: Manager<'_>,
    draft: ConnectionDraft,
    password: Option<SecretString>,
) -> Result<ConnectionProfile, AppError> {
    run(&manager, move |m| m.create(draft, password)).await
}

#[tauri::command]
pub async fn connection_update(
    manager: Manager<'_>,
    sessions: Live<'_>,
    id: String,
    draft: ConnectionDraft,
    password: Option<PasswordChange>,
) -> Result<ConnectionProfile, AppError> {
    let profile = run(&manager, move |m| {
        m.update(&id, draft, password.unwrap_or_default())
    })
    .await?;
    // The schema scope applies at once; other connection settings at the next connect.
    sessions
        .set_schema_scope(&profile.id, &profile.draft.schema_scope())
        .await;
    Ok(profile)
}

#[tauri::command]
pub async fn connection_duplicate(
    manager: Manager<'_>,
    id: String,
) -> Result<ConnectionProfile, AppError> {
    run(&manager, move |m| m.duplicate(&id)).await
}

#[tauri::command]
pub async fn connection_delete(
    manager: Manager<'_>,
    sessions: Live<'_>,
    id: String,
) -> Result<(), AppError> {
    sessions.disconnect(&id).await;
    run(&manager, move |m| m.delete(&id)).await
}

#[tauri::command]
pub async fn connection_rename(
    manager: Manager<'_>,
    id: String,
    name: String,
) -> Result<ConnectionProfile, AppError> {
    run(&manager, move |m| m.rename(&id, &name)).await
}

/// Moves a data source into a folder (`None` = top level) at `index` among its data sources.
#[tauri::command]
pub async fn connection_move(
    manager: Manager<'_>,
    id: String,
    folder_id: Option<String>,
    index: usize,
) -> Result<(), AppError> {
    run(&manager, move |m| {
        m.move_to(&id, folder_id.as_deref(), index)
    })
    .await
}

// ---- Folders (M4.9) ----

#[tauri::command]
pub async fn folders_list(manager: Manager<'_>) -> Result<Vec<Folder>, AppError> {
    run(&manager, |m| m.folders()).await
}

#[tauri::command]
pub async fn folder_create(
    manager: Manager<'_>,
    name: String,
    color: Option<String>,
) -> Result<Folder, AppError> {
    run(&manager, move |m| m.create_folder(&name, color)).await
}

#[tauri::command]
pub async fn folder_update(
    manager: Manager<'_>,
    folder_id: String,
    name: String,
    color: Option<String>,
) -> Result<Folder, AppError> {
    run(&manager, move |m| m.update_folder(&folder_id, &name, color)).await
}

/// Deletes a folder; its data sources move to the top level.
#[tauri::command]
pub async fn folder_delete(manager: Manager<'_>, folder_id: String) -> Result<(), AppError> {
    run(&manager, move |m| m.delete_folder(&folder_id)).await
}

// ---- SSH profiles and host keys (M4.9). Secrets go in; nothing returns one. ----

#[tauri::command]
pub async fn ssh_profiles_list(manager: Manager<'_>) -> Result<Vec<SshProfile>, AppError> {
    run(&manager, |m| m.ssh_profiles()).await
}

#[tauri::command]
pub async fn ssh_profile_create(
    manager: Manager<'_>,
    draft: SshProfileDraft,
    secret: Option<SecretString>,
) -> Result<SshProfile, AppError> {
    run(&manager, move |m| m.create_ssh_profile(draft, secret)).await
}

#[tauri::command]
pub async fn ssh_profile_update(
    manager: Manager<'_>,
    profile_id: String,
    draft: SshProfileDraft,
    secret: Option<PasswordChange>,
) -> Result<SshProfile, AppError> {
    run(&manager, move |m| {
        m.update_ssh_profile(&profile_id, draft, secret.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn ssh_profile_delete(manager: Manager<'_>, profile_id: String) -> Result<(), AppError> {
    run(&manager, move |m| m.delete_ssh_profile(&profile_id)).await
}

/// Trusts the host key the SSH server at `host:port` presented on the last attempt. The
/// fingerprint must match that key: the UI confirms what it was shown, nothing else.
#[tauri::command]
pub async fn ssh_host_trust(
    tunnels: State<'_, Arc<Tunnels>>,
    host: String,
    port: u16,
    fingerprint: String,
) -> Result<(), AppError> {
    let tunnels = Arc::clone(&tunnels);
    tauri::async_runtime::spawn_blocking(move || tunnels.trust(&host, port, &fingerprint))
        .await
        .map_err(|e| AppError::new("internal", format!("task failed: {e}")))?
}

/// What a file is picked for; sets the dialog's title and filters.
#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FilePurpose {
    SshKey,
    TlsCa,
    TlsCert,
    TlsKey,
}

/// Native open dialog; the absolute path of the chosen file, or `None` if cancelled. Only the
/// path is stored: key and certificate contents are read at connect time.
#[tauri::command]
pub async fn file_pick(app: AppHandle, purpose: FilePurpose) -> Result<Option<String>, AppError> {
    let (title, filter): (&str, Option<(&str, &[&str])>) = match purpose {
        FilePurpose::SshKey => ("Choose SSH Private Key", None),
        FilePurpose::TlsCa => (
            "Choose CA Certificate",
            Some(("PEM certificates", &["pem", "crt", "cer"])),
        ),
        FilePurpose::TlsCert => (
            "Choose Client Certificate",
            Some(("PEM certificates", &["pem", "crt", "cer"])),
        ),
        FilePurpose::TlsKey => ("Choose Client Key", Some(("PEM keys", &["pem", "key"]))),
    };
    let mut dialog = app.dialog().file().set_title(title);
    if let Some((name, extensions)) = filter {
        dialog = dialog
            .add_filter(name, extensions)
            .add_filter("All files", &["*"]);
    }
    if let (FilePurpose::SshKey, Ok(home)) = (purpose, app.path().home_dir()) {
        dialog = dialog.set_directory(home.join(".ssh"));
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| AppError::new("internal", format!("dialog failed: {e}")))?;
    picked
        .map(|p| {
            p.into_path()
                .map(|p| p.display().to_string())
                .map_err(|e| AppError::new("invalid", e.to_string()))
        })
        .transpose()
}

// ---- Connectivity (M2.2) ----

use quarry_db_core::{
    ConnectParams, MetaNode, MetadataRequest, ObjectDetails, ObjectRef, ServerInfo, TxSettings,
};
use tauri::{AppHandle, Manager as _};

use crate::sessions::{SessionStatus, Sessions};

type Live<'a> = State<'a, Arc<Sessions>>;

/// What the dialog sends for its SSH tab when testing: the (possibly unsaved) profile and the
/// typed secret.
#[derive(Debug, Default, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshTest {
    /// The SSH profile as edited; `None` uses the saved profile the draft refers to.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub profile: Option<SshProfileDraft>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional, type = "string"))]
    pub secret: Option<SecretString>,
}

/// Parameters for a (possibly unsaved) draft, with its SSH tunnel open if it uses one.
async fn draft_params(
    manager: &Arc<ConnectionManager>,
    tunnels: &Tunnels,
    draft: ConnectionDraft,
    id: Option<String>,
    password: Option<SecretString>,
    ssh: SshTest,
) -> Result<ConnectParams, AppError> {
    let tunnel_draft = draft.clone();
    let mut params = run(manager, move |m| {
        let pw = m.resolve_password(id.as_deref(), password)?;
        quarry_connections::connect_params(draft, pw)
    })
    .await?;
    tunnels
        .attach(manager, &tunnel_draft, ssh.profile, ssh.secret, &mut params)
        .await?;
    Ok(params)
}

/// Tests a (possibly unsaved) draft. `id` lets an edited profile reuse its stored password;
/// an explicit `password` (typed in the dialog) wins. `ssh` likewise for the tunnel.
#[tauri::command]
pub async fn connection_test(
    manager: Manager<'_>,
    sessions: Live<'_>,
    tunnels: State<'_, Arc<Tunnels>>,
    draft: ConnectionDraft,
    id: Option<String>,
    password: Option<SecretString>,
    ssh: Option<SshTest>,
) -> Result<ServerInfo, AppError> {
    let ssh = ssh.unwrap_or_default();
    let params = draft_params(&manager, &tunnels, draft, id, password, ssh).await?;
    sessions.test(&params).await
}

/// Every schema of a (possibly unsaved) draft's database, for the schema scope selector. Uses the
/// live session when the data source is connected, a short-lived connection otherwise.
#[tauri::command]
pub async fn connection_schemas(
    manager: Manager<'_>,
    sessions: Live<'_>,
    tunnels: State<'_, Arc<Tunnels>>,
    draft: ConnectionDraft,
    id: Option<String>,
    password: Option<SecretString>,
    ssh: Option<SshTest>,
) -> Result<Vec<String>, AppError> {
    let request = MetadataRequest::AllSchemas;
    let live = match &id {
        Some(id) => sessions.metadata(id, &request).await.ok(),
        None => None,
    };
    let nodes = match live {
        Some(nodes) => nodes,
        None => {
            let ssh = ssh.unwrap_or_default();
            let params = draft_params(&manager, &tunnels, draft, id, password, ssh).await?;
            sessions.metadata_once(&params, &request).await?
        }
    };
    Ok(nodes.into_iter().map(|n| n.name).collect())
}

#[tauri::command]
pub async fn connection_connect(
    app: AppHandle,
    manager: Manager<'_>,
    sessions: Live<'_>,
    id: String,
    password: Option<SecretString>,
    ssh_secret: Option<SecretString>,
) -> Result<ServerInfo, AppError> {
    let key = id.clone();
    let (mut params, draft, defaults) = run(&manager, move |m| {
        let profile = m.profile(&key)?;
        let defaults = TxSettings {
            mode: profile.draft.tx_mode,
            isolation: profile.draft.isolation,
        };
        let pw = m.resolve_password(Some(&key), password)?;
        Ok((
            quarry_connections::connect_params(profile.draft.clone(), pw)?,
            profile.draft,
            defaults,
        ))
    })
    .await?;
    if sessions.is_connected(&id).await {
        // Already connected: no tunnel needed (connect returns the live session's info).
        return sessions
            .inner()
            .connect(&app, &id, &params, defaults, None)
            .await;
    }
    let tunnels = app.state::<Arc<Tunnels>>();
    tunnels
        .attach(&manager, &draft, None, ssh_secret, &mut params)
        .await?;
    let idle = (draft.auto_disconnect_mins > 0)
        .then(|| std::time::Duration::from_secs(u64::from(draft.auto_disconnect_mins) * 60));
    sessions
        .inner()
        .connect(&app, &id, &params, defaults, idle)
        .await
}

#[tauri::command]
pub async fn connection_disconnect(sessions: Live<'_>, id: String) -> Result<(), AppError> {
    sessions.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn sessions_list(sessions: Live<'_>) -> Result<Vec<SessionStatus>, AppError> {
    Ok(sessions.list().await)
}

/// One level of the explorer tree for a connected data source.
#[tauri::command]
pub async fn metadata_children(
    sessions: Live<'_>,
    id: String,
    request: MetadataRequest,
) -> Result<Vec<MetaNode>, AppError> {
    sessions.metadata(&id, &request).await
}

/// Everything the table viewer shows for one object; `None` if it no longer exists.
#[tauri::command]
pub async fn object_details(
    sessions: Live<'_>,
    id: String,
    object: ObjectRef,
) -> Result<Option<ObjectDetails>, AppError> {
    Ok(sessions
        .get(&crate::sessions::SessionKey::shared(&id))
        .await?
        .object_details(&object)
        .await?)
}
