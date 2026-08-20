use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
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
    /// This window's workspace root — `commands::workspace_open`'s own
    /// `root` argument, kept alongside the session rather than only ever
    /// passed around as a plain `String` so `crate::materialize` has
    /// somewhere to write `materialized.md`/`materialized-dbs/` without
    /// needing its own separate root-tracking map.
    pub root: PathBuf,
}

/// Settings' "Storage > Materialize" switches — see `crate::materialize`.
/// Global rather than per-window, same as `AppSettings` itself: there's one
/// app-wide Settings page, not a per-workspace one, so every open window's
/// workspace materializes (or doesn't) the same way.
#[derive(Clone, Copy, Default)]
pub struct MaterializeConfig {
    pub markdown: bool,
    pub dbs: bool,
}

/// A running `dendroid-mcp` server this process started — just enough to
/// stop it again (or replace it, on a config change) via its cancellation
/// token. See `crate::mcp`.
pub struct McpHandle {
    pub cancellation_token: CancellationToken,
}

/// One window's connection to a spawned ACP agent process, plus the
/// session it opened on it. See `crate::acp`.
pub struct AcpSession {
    pub client: dendroid_acp::AcpClient,
    pub session_id: String,
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
    /// One agent session per *chat thread*, keyed by [`acp_key`] (window
    /// label + thread id) rather than window label alone — the chat
    /// drawer's own documents, unrelated to the "primary" window concept
    /// `mcp_handle` uses. A window can hold several threads open against
    /// the agent binary at once (see `components/agent/AgentPanel.tsx`),
    /// each spawning its own agent process so their conversations stay
    /// fully independent. Present for a given thread only once that
    /// thread's ever connected (`crate::acp::acp_start`); absent otherwise,
    /// including after that thread's session is stopped or the window
    /// closes.
    pub acp_sessions: Mutex<HashMap<String, AcpSession>>,
    /// Guards `agent_runtime::ensure_bun`'s download-and-cache step so two
    /// threads connecting for the first time at once (e.g. two chat
    /// threads opened together) don't both download the runtime — the
    /// second just waits for the first to finish, then finds the cache
    /// already populated. Never held across anything but that setup, so
    /// it's not on the hot path for a thread that's already connected.
    pub bun_setup: Mutex<()>,
    /// Settings' "Storage > Materialize" switches — see `crate::materialize`.
    pub materialize_config: Mutex<MaterializeConfig>,
    /// One debounce generation counter per (window label, "markdown" or
    /// "dbs") — see `crate::materialize::schedule`'s doc comment for how
    /// this actually debounces. Entries accumulate for the lifetime of the
    /// process rather than being cleaned up on window close; each one is
    /// just a `u64`, so this never grows large enough to matter.
    pub materialize_generations: Mutex<HashMap<String, Arc<AtomicU64>>>,
}

/// Builds the composite key `AppDocState::acp_sessions` is keyed by — see
/// that field's doc comment for why it's (window, thread) rather than just
/// window. `::` can't appear in a Tauri window label or a `crypto.
/// randomUUID()` thread id, so this can't collide across windows/threads.
pub fn acp_key(window_label: &str, thread_id: &str) -> String {
    format!("{window_label}::{thread_id}")
}

impl AppDocState {
    pub fn new() -> Self {
        Self {
            session_id: dendroid_core::new_session_id(),
            sessions: Mutex::new(HashMap::new()),
            primary_label: Mutex::new(None),
            mcp_handle: Mutex::new(None),
            acp_sessions: Mutex::new(HashMap::new()),
            bun_setup: Mutex::new(()),
            materialize_config: Mutex::new(MaterializeConfig::default()),
            materialize_generations: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for AppDocState {
    fn default() -> Self {
        Self::new()
    }
}
