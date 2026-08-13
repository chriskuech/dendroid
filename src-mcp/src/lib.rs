//! MCP server exposing `dendroid_core`'s outline/tree/insert/replaceContent
//! over the streamable-HTTP transport, matching the `http://host:port/mcp`
//! shape Settings' "Local MCP" section already advertises (see
//! `SettingsPage.tsx`'s `mcpConfig`).
//!
//! This crate is deliberately thin: every tool method here is a straight
//! wrapper around a `DendroidDocument`/`markdown` method that already
//! exists in `dendroid_core` — `getTree` in particular is the same
//! `resolve_slice` primitive the `@`-links plan calls out as meant to be
//! shared with the editor's own (not-yet-lazily-loaded) rendering, so this
//! server isn't a separate implementation of "what's in this section," just
//! another caller of it.
//!
//! Runs in-process inside the Tauri app (see `src-tauri`'s `mcp` module),
//! operating on the same `NativeDocument` session the GUI itself has open
//! rather than a second independent one — so an MCP client's edits show up
//! live in the editor the same way a remote ledger merge would.
//!
//! Each `#[tool]` here is one "skill" Settings' "Skills" section can list
//! (`tool_catalog`) and individually turn off (`new`'s `disabled_tools`) —
//! both the ACP chat drawer, which connects to this same server as an ACP
//! `mcpServers` entry (see `src-tauri/src/acp.rs`), and any other MCP
//! client only ever see and can call whatever's currently enabled.

use std::net::SocketAddr;
use std::sync::Arc;

use dendroid_core::native::{NativeDocument, NativeSqlWorkspace};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

fn default_depth() -> u32 {
    3
}

fn default_link_depth() -> u32 {
    1
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetTreeParams {
    /// Heading id to root the slice at. Omit for the whole document.
    pub id: Option<String>,
    /// Heading levels to include below the root.
    #[serde(default = "default_depth")]
    pub depth: u32,
    /// Inline each `@`-link's own target subtree instead of leaving it as
    /// a bare `@{heading-id}` reference.
    #[serde(default)]
    pub expand_links: bool,
    /// How many levels deep an expanded link's own subtree goes.
    #[serde(default = "default_link_depth")]
    pub link_depth: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentParams {
    /// The heading id to insert into / replace the contents of.
    pub id: String,
    /// Markdown — the same subset `getTree` renders (paragraphs, headings,
    /// bold/italic/strike/code marks, code blocks, blockquotes, flat
    /// bullet/ordered lists, horizontal rules) plus `@{heading-id}` for an
    /// `@`-link.
    pub content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DbCreateParams {
    /// Display name for the new database.
    pub name: String,
}

fn default_batch() -> bool {
    false
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DbExecParams {
    /// The database id (see `dbList`).
    pub id: String,
    /// One SQL statement, or (if `batch`) a `;`-separated script.
    pub sql: String,
    /// Positional `?1`/`?2`/... parameters for a non-batch statement.
    #[serde(default)]
    pub params: Vec<JsonValue>,
    /// Run `sql` as a multi-statement script via `execute_batch` (no bound
    /// params) instead of a single parameterized statement.
    #[serde(default = "default_batch")]
    pub batch: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DbIdParams {
    pub id: String,
}

fn default_row_limit() -> u32 {
    50
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DbTableRowsParams {
    pub id: String,
    pub table: String,
    #[serde(default = "default_row_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    /// Sort by this column instead of `rowid` — must name a real column of
    /// `table` (or be `"rowid"` itself).
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default)]
    pub order_desc: bool,
}

/// The MCP-facing surface — one `NativeDocument`/`NativeSqlWorkspace` pair
/// shared with whatever else (Tauri commands, the ledger-poll thread) is
/// driving the same session, each guarded by a plain `tokio::sync::Mutex`
/// since every tool call here is already async end to end.
#[derive(Clone)]
pub struct DendroidMcpServer {
    doc: Arc<Mutex<NativeDocument>>,
    sql: Arc<Mutex<NativeSqlWorkspace>>,
    // Read by the `#[tool_handler]`-generated `ServerHandler` methods
    // below, not by anything in this file directly — dead-code analysis
    // doesn't see through that, same as upstream rmcp's own tests.
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl DendroidMcpServer {
    /// `disabled_tools` names tools (see `tool_catalog`) that Settings'
    /// "Skills" section has turned off — routed through `ToolRouter`'s own
    /// `disable_route` rather than filtered by hand here, so the same
    /// enforcement rmcp already gives `list_tools`/`call_tool` (hidden from
    /// the tool list, rejected with "tool not found" if called anyway)
    /// covers a disabled skill with no extra code in this file.
    pub fn new(doc: Arc<Mutex<NativeDocument>>, sql: Arc<Mutex<NativeSqlWorkspace>>, disabled_tools: &[String]) -> Self {
        let mut tool_router = Self::tool_router();
        for name in disabled_tools {
            tool_router.disable_route(name.clone());
        }
        Self { doc, sql, tool_router }
    }

    /// The full catalog of tools this server can expose — every one of
    /// them, regardless of `disabled_tools`, since this doesn't depend on
    /// an instance at all. Settings' "Skills" section calls this (via
    /// `mcp_list_skills`) to render name/description + an enable/disable
    /// switch for each, independent of whether "Local MCP" is even
    /// running.
    pub fn tool_catalog() -> Vec<rmcp::model::Tool> {
        Self::tool_router().list_all()
    }

    #[tool(name = "getOutline", description = "Returns just the document's headings (with their stable ids), as JSON.")]
    async fn get_outline(&self) -> Result<String, ErrorData> {
        let doc = self.doc.lock().await;
        let outline = doc.outline().map_err(to_mcp_error)?;
        serde_json::to_string(&outline).map_err(|e| ErrorData::internal_error(e.to_string(), None))
    }

    #[tool(
        name = "getTree",
        description = "Returns markdown for a slice of the document rooted at a heading id (or the whole document), optionally expanding @-links inline."
    )]
    async fn get_tree(&self, params: Parameters<GetTreeParams>) -> Result<String, ErrorData> {
        let GetTreeParams { id, depth, expand_links, link_depth } = params.0;
        let doc = self.doc.lock().await;
        doc.get_tree(id.as_deref(), depth, expand_links, link_depth).map_err(to_mcp_error)
    }

    #[tool(name = "insert", description = "Appends markdown content inside the given heading's section, after whatever's already there.")]
    async fn insert(&self, params: Parameters<ContentParams>) -> Result<String, ErrorData> {
        let ContentParams { id, content } = params.0;
        let mut doc = self.doc.lock().await;
        doc.insert(&id, &content).await.map_err(to_mcp_error)?;
        Ok("inserted".to_string())
    }

    #[tool(
        name = "replaceContent",
        description = "Replaces everything inside the given heading's section (its body content and nested subheadings) with new markdown content. The heading itself — its title and level — is untouched."
    )]
    async fn replace_content(&self, params: Parameters<ContentParams>) -> Result<String, ErrorData> {
        let ContentParams { id, content } = params.0;
        let mut doc = self.doc.lock().await;
        doc.replace_content(&id, &content).await.map_err(to_mcp_error)?;
        Ok("replaced".to_string())
    }

    #[tool(name = "dbList", description = "Lists every SQLite database in this workspace, as JSON (id + name).")]
    async fn db_list(&self) -> Result<String, ErrorData> {
        let sql = self.sql.lock().await;
        serde_json::to_string(&sql.list_databases()).map_err(|e| ErrorData::internal_error(e.to_string(), None))
    }

    #[tool(name = "dbCreate", description = "Creates a new, empty SQLite database and returns its id.")]
    async fn db_create(&self, params: Parameters<DbCreateParams>) -> Result<String, ErrorData> {
        let DbCreateParams { name } = params.0;
        let mut sql = self.sql.lock().await;
        sql.create_database(&name).await.map_err(to_mcp_error)
    }

    #[tool(
        name = "dbExec",
        description = "Runs one SQL statement (INSERT/UPDATE/DELETE/CREATE TABLE/DROP TABLE/...) against a database, or — with batch=true — a `;`-separated multi-statement script. Bound params (?1, ?2, ...) are only honored when batch is false."
    )]
    async fn db_exec(&self, params: Parameters<DbExecParams>) -> Result<String, ErrorData> {
        let DbExecParams { id, sql, params, batch } = params.0;
        let mut db = self.sql.lock().await;
        db.exec(&id, &sql, params, batch).await.map_err(to_mcp_error)?;
        Ok("executed".to_string())
    }

    #[tool(name = "dbTables", description = "Lists a database's user tables and their columns, as JSON.")]
    async fn db_tables(&self, params: Parameters<DbIdParams>) -> Result<String, ErrorData> {
        let DbIdParams { id } = params.0;
        let sql = self.sql.lock().await;
        let tables = sql.list_tables(&id).map_err(to_mcp_error)?;
        serde_json::to_string(&tables).map_err(|e| ErrorData::internal_error(e.to_string(), None))
    }

    #[tool(name = "dbTableRows", description = "Returns a page of a table's rows (plus column metadata and the total row count), as JSON.")]
    async fn db_table_rows(&self, params: Parameters<DbTableRowsParams>) -> Result<String, ErrorData> {
        let DbTableRowsParams { id, table, limit, offset, order_by, order_desc } = params.0;
        let sql = self.sql.lock().await;
        let rows = sql.table_rows(&id, &table, limit, offset, order_by.as_deref(), order_desc).map_err(to_mcp_error)?;
        serde_json::to_string(&rows).map_err(|e| ErrorData::internal_error(e.to_string(), None))
    }
}

// `router = self.tool_router` — without it, `#[tool_handler]` defaults to
// generating `list_tools`/`call_tool`/`get_tool` against a *fresh*
// `Self::tool_router()` call (a brand-new, nothing-disabled router) rather
// than this instance's own `self.tool_router`, silently ignoring every
// `disable_route` call `new` made. That default is meant for the common
// case of a server with no per-instance router state at all; this one has
// exactly that, via `disabled_tools`, so it has to be named explicitly.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for DendroidMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("dendroid", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Tools for reading and editing a dendroid workspace's markdown graph. \
                 Headings are addressed by their stable id (see getOutline); @-links point \
                 at a heading the same way and survive renames.",
            )
    }
}

fn to_mcp_error(err: dendroid_core::DendroidError) -> ErrorData {
    ErrorData::internal_error(err.to_string(), None)
}

/// Binds `addr` — split out from `serve_on` so a caller that needs the
/// actual bound address (tests using port `0` for an OS-assigned one; a
/// future "port already in use" retry) can get it before the listener
/// starts accepting.
pub async fn bind(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(addr).await
}

/// Serves `doc`/`sql` over streamable-HTTP on an already-bound `listener`
/// (`/mcp`, matching what Settings advertises) until `cancellation_token`
/// fires.
pub async fn serve_on(
    doc: Arc<Mutex<NativeDocument>>,
    sql: Arc<Mutex<NativeSqlWorkspace>>,
    listener: tokio::net::TcpListener,
    cancellation_token: CancellationToken,
    disabled_tools: Vec<String>,
) -> std::io::Result<()> {
    let config = StreamableHttpServerConfig::default().with_cancellation_token(cancellation_token.clone());
    let service: StreamableHttpService<DendroidMcpServer, LocalSessionManager> = StreamableHttpService::new(
        move || Ok(DendroidMcpServer::new(doc.clone(), sql.clone(), &disabled_tools)),
        Default::default(),
        config,
    );
    let router = axum::Router::new().nest_service("/mcp", service);

    axum::serve(listener, router).with_graceful_shutdown(async move { cancellation_token.cancelled_owned().await }).await
}

/// `bind` + `serve_on` — one call per "Local MCP" enable. `src-tauri`'s
/// `mcp` module owns starting/stopping this alongside the settings toggle.
pub async fn serve(
    doc: Arc<Mutex<NativeDocument>>,
    sql: Arc<Mutex<NativeSqlWorkspace>>,
    addr: SocketAddr,
    cancellation_token: CancellationToken,
    disabled_tools: Vec<String>,
) -> std::io::Result<()> {
    let listener = bind(addr).await?;
    serve_on(doc, sql, listener, cancellation_token, disabled_tools).await
}
