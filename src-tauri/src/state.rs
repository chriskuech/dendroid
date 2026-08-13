use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use dendroid_core::native::{NativeDocument, NativeSqlWorkspace};

pub struct Session {
    /// `Arc`-wrapped (not just owned) so the MCP server — see `crate::mcp`
    /// — can hold its own clone of the *primary* session's doc and operate
    /// on the exact same in-memory state Tauri commands and the
    /// ledger-poll thread already share, rather than opening a second,
    /// independent replica.
    pub doc: Arc<Mutex<NativeDocument>>,
    /// This window's SQLite databases — a separate store from `doc` (see
    /// `dendroid_core::sqldb`'s module doc comment for why), opened
    /// alongside it in `commands::workspace_open` and torn down the same
    /// way (`lib.rs`'s `on_window_event`).
    pub sql: Arc<Mutex<NativeSqlWorkspace>>,
}

/// A running `dendroid-mcp` server this process started — just enough to
/// stop it again (or replace it, on a config change) via its cancellation
/// token. See `crate::mcp`.
pub struct McpHandle {
    pub cancellation_token: CancellationToken,
}

/// One session id per running app process — this is what makes ledger
/// filenames collision-free across replicas of the same workspace folder
/// (see `dendroid_core::ledger`). Generated once at startup and reused for
/// whatever workspace(s) get opened during this process's lifetime.
///
/// `tokio::sync::Mutex`, not `std::sync::Mutex`: commands hold this guard
/// across `.await` points (opening/importing into `doc` is async, since
/// `NativeDocument`'s `LedgerStorage` API is — see `dendroid_core::storage`),
/// and a `std::sync::MutexGuard` held across an await isn't `Send`, which
/// tauri's async command futures need to be.
pub struct AppDocState {
    pub session_id: String,
    /// One `Session` per *window*, keyed by window label, not one global
    /// session — "File > Open Workspace in New Window" opens another
    /// window with its own workspace open independently of every other
    /// one. `commands.rs` looks its caller's session up by the window the
    /// IPC call came from; the ledger-poll thread in `lib.rs` walks every
    /// entry and emits each session's updates only to its own window
    /// (`emit_to`), so two windows on two different workspaces never see
    /// each other's traffic. A window's entry is removed when it closes
    /// (see `lib.rs`'s `on_window_event`).
    pub sessions: Mutex<HashMap<String, Session>>,
    /// The label of whichever window's session the local MCP server (if
    /// running) operates on — the app doesn't have a per-workspace MCP
    /// concept, just one process-wide "Local MCP" toggle in Settings, so
    /// it has to pick one session. Whichever window opens a workspace
    /// *first* in this process's lifetime claims it; see `commands.rs`'s
    /// `workspace_open`. Cleared when that window closes, at which point
    /// the next `workspace_open` call (in any window) claims it again.
    pub primary_label: Mutex<Option<String>>,
    /// The currently-running MCP server, if "Local MCP" is enabled — see
    /// `crate::mcp`.
    pub mcp_handle: Mutex<Option<McpHandle>>,
}

impl AppDocState {
    pub fn new() -> Self {
        Self {
            session_id: dendroid_core::new_session_id(),
            sessions: Mutex::new(HashMap::new()),
            primary_label: Mutex::new(None),
            mcp_handle: Mutex::new(None),
        }
    }
}

impl Default for AppDocState {
    fn default() -> Self {
        Self::new()
    }
}
