//! Transaction mode and state of a session (REQ-TX-01, REQ-EDIT-09).

use serde::{Deserialize, Serialize};

/// The session's transaction after the last statement, as the server reports it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    /// No transaction block is open: the next statement commits on its own.
    #[default]
    Idle,
    /// A transaction block is open; changes are visible to this session only until Commit.
    Active,
    /// A statement failed inside the block. Every further statement fails until Rollback.
    Failed,
}

/// When statements commit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum TxMode {
    /// Each statement commits as it finishes (unless the user opened a block with BEGIN).
    #[default]
    Auto,
    /// The first statement opens a transaction; it stays open until Commit or Rollback.
    Manual,
}

/// Isolation level for transactions opened in Manual mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Isolation {
    #[default]
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl Isolation {
    /// The SQL spelling, for `BEGIN ISOLATION LEVEL …`.
    pub fn sql(self) -> &'static str {
        match self {
            Self::ReadCommitted => "READ COMMITTED",
            Self::RepeatableRead => "REPEATABLE READ",
            Self::Serializable => "SERIALIZABLE",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TxSettings {
    pub mode: TxMode,
    pub isolation: Isolation,
}
