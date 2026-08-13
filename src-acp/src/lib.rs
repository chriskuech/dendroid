//! A minimal [Agent Client Protocol](https://agentclientprotocol.com) (ACP)
//! *client*: spawns an ACP-speaking agent binary as a child process and
//! speaks the protocol's JSON-RPC 2.0 messages — one per line — over its
//! stdin/stdout. This is the "editor" side of ACP; dendroid is the editor,
//! the spawned process is the agent (e.g. a Claude Code or Gemini CLI ACP
//! adapter).
//!
//! Deliberately not a full typed implementation of every ACP method — only
//! `initialize`, `session/new`, `session/prompt`, `session/cancel`, and
//! `session/request_permission` are needed to drive dendroid's chat drawer
//! (`components/agent/AgentPanel.tsx`, via `src-tauri/src/acp.rs`). Content
//! inside `session/update` notifications and `session/request_permission`
//! params is forwarded as raw [`serde_json::Value`] rather than modeled
//! field-by-field, so a future ACP update kind this crate doesn't know
//! about still reaches the frontend instead of being dropped or rejected —
//! see `AcpEvent::Update`'s doc comment.
//!
//! `fs/*` and `terminal/*` requests aren't supported: `initialize`
//! advertises no `fs`/`terminal` client capabilities, so a spec-compliant
//! agent won't send them; if one does anyway (or sends any other method we
//! don't recognize), it gets back a JSON-RPC "method not found" error
//! rather than hanging forever waiting on a reply we'd never send.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

/// The ACP protocol revision this client speaks. Sent as `initialize`'s
/// `protocolVersion`; an agent that only supports a different revision is
/// expected to say so in its response rather than this client refusing to
/// talk to it — negotiating that is out of scope for this minimal client.
const PROTOCOL_VERSION: i64 = 1;

/// Events streamed out of a running agent session, for the host (dendroid's
/// Tauri command layer — see `src-tauri/src/acp.rs`) to forward to whatever
/// UI is driving it.
#[derive(Debug, Clone)]
pub enum AcpEvent {
    /// A `session/update` notification's `params`, forwarded verbatim. The
    /// exact shape — `params.update.sessionUpdate` is `"agent_message_chunk"`,
    /// `"tool_call"`, `"plan"`, etc. — is defined by the ACP spec; kept as
    /// raw JSON here rather than a Rust enum so this crate (and the Tauri
    /// layer between it and the frontend) never needs updating just because
    /// the spec grows a new update kind. The frontend interprets it.
    Update(Value),
    /// The agent is asking the client (dendroid) to approve or deny a tool
    /// call — a `session/request_permission` request. `request_id` is that
    /// request's JSON-RPC id and must be echoed back unchanged via
    /// [`AcpClient::respond_permission`]; `params` is its raw `params`
    /// (`toolCall`, `options`, …).
    PermissionRequest { request_id: Value, params: Value },
    /// The agent process's stdio closed — it exited on its own, crashed, or
    /// [`AcpClient::shutdown`] killed it. `error` is set when this was
    /// unexpected (a read/parse failure) rather than a clean shutdown; a
    /// clean `shutdown()` call races this event and the two are otherwise
    /// indistinguishable, so callers shouldn't read `error: None` as proof
    /// nothing went wrong, only that nothing *readable* did.
    Closed { error: Option<String> },
}

/// Everything that can go wrong talking to an agent process: it wouldn't
/// launch, a call it received came back as a JSON-RPC error, or its stdio
/// closed before answering. Always carries a human-readable message —
/// there's no programmatic recovery path finer-grained than "tell the user
/// and let them retry", so no need for a richer error enum here.
#[derive(Debug)]
pub struct AcpError(pub String);

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for AcpError {}

impl From<std::io::Error> for AcpError {
    fn from(e: std::io::Error) -> Self {
        AcpError(e.to_string())
    }
}

/// Outstanding requests *we* sent, keyed by the JSON-RPC id we assigned
/// them — filled in by [`AcpClient::request`], drained by the reader task
/// in [`AcpClient::spawn`] as responses arrive (or, if the agent's stdio
/// closes first, drained with an error so no caller hangs forever).
type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, Value>>>>>;

/// A live connection to one spawned agent process. Cheap to clone — every
/// field is `Arc`-wrapped, so all clones share the same underlying process,
/// stdin, and pending-request table; `src-tauri/src/acp.rs` relies on this
/// to hand a clone to a long-running `prompt()` call without holding its
/// session-table lock for the call's whole duration.
#[derive(Clone)]
pub struct AcpClient {
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: Arc<AtomicI64>,
    pending: PendingMap,
    child: Arc<Mutex<Child>>,
}

impl AcpClient {
    /// Spawns `command args` with `cwd` as its working directory, wires up
    /// its stdio, and completes the ACP handshake (`initialize`). Returns
    /// the client plus a channel of [`AcpEvent`]s the caller should drain
    /// for as long as the session is alive — nothing else observes agent-
    /// initiated notifications/requests or the process closing.
    pub async fn spawn(command: &str, args: &[String], cwd: &str) -> Result<(Self, mpsc::UnboundedReceiver<AcpEvent>), AcpError> {
        let mut child = Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AcpError(format!("failed to launch {command:?}: {e}")))?;

        let stdin = child.stdin.take().ok_or_else(|| AcpError("agent process has no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| AcpError("agent process has no stdout".into()))?;
        let stderr = child.stderr.take();

        let (tx, rx) = mpsc::unbounded_channel();
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let stdin = Arc::new(Mutex::new(stdin));

        // The agent's own diagnostic output — not part of the protocol, but
        // worth surfacing somewhere rather than silently discarding (or,
        // worse, leaving unread and letting the pipe fill up and block the
        // agent's own writes).
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[acp:stderr] {line}");
                }
            });
        }

        {
            let pending = pending.clone();
            let stdin_for_replies = stdin.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if line.trim().is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<Value>(&line) {
                                Ok(value) => dispatch_incoming(value, &pending, &stdin_for_replies, &tx).await,
                                Err(e) => eprintln!("[acp] malformed message from agent, ignoring: {e}"),
                            }
                        }
                        Ok(None) => {
                            let _ = tx.send(AcpEvent::Closed { error: None });
                            break;
                        }
                        Err(e) => {
                            let _ = tx.send(AcpEvent::Closed { error: Some(e.to_string()) });
                            break;
                        }
                    }
                }
                // Nothing is ever going to answer these now — fail them
                // rather than leaving every in-flight call hanging forever.
                let mut pending = pending.lock().await;
                for (_, tx) in pending.drain() {
                    let _ = tx.send(Err(json!({"message": "agent process closed"})));
                }
            });
        }

        let client = AcpClient { stdin, next_id: Arc::new(AtomicI64::new(1)), pending, child: Arc::new(Mutex::new(child)) };
        client.initialize().await?;
        Ok((client, rx))
    }

    async fn initialize(&self) -> Result<Value, AcpError> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    // Neither is implemented on dendroid's side yet, so
                    // both are declared unsupported rather than advertised
                    // and then answered with "method not found" — an agent
                    // is entitled to rely on a capability it was told is
                    // there.
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                }
            }),
        )
        .await
    }

    /// Opens a new session rooted at `cwd` and returns its `sessionId`.
    pub async fn new_session(&self, cwd: &str) -> Result<String, AcpError> {
        let result = self.request("session/new", json!({ "cwd": cwd, "mcpServers": [] })).await?;
        result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AcpError("session/new response missing sessionId".into()))
    }

    /// Sends one user turn as plain text and awaits the agent's full
    /// response (its raw `session/prompt` result, e.g. `{"stopReason": …}`)
    /// — that only arrives once the whole turn ends. The turn's actual
    /// content streams separately, as `AcpEvent::Update` notifications on
    /// the channel `spawn` returned, for as long as this call is pending.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<Value, AcpError> {
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }],
            }),
        )
        .await
    }

    /// Asks the agent to stop the current turn early (`session/cancel`) —
    /// a notification, not a request: ACP doesn't ack it directly, the
    /// in-flight `prompt()` call is expected to resolve on its own shortly
    /// after, with a `"cancelled"` stop reason.
    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpError> {
        self.notify("session/cancel", json!({ "sessionId": session_id })).await
    }

    /// Answers a pending `session/request_permission` request — `request_id`
    /// must be the exact value from the matching `AcpEvent::PermissionRequest`,
    /// `outcome` the ACP `RequestPermissionOutcome` object (e.g.
    /// `{"outcome": "selected", "optionId": "..."}` or `{"outcome": "cancelled"}`).
    pub async fn respond_permission(&self, request_id: Value, outcome: Value) -> Result<(), AcpError> {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "outcome": outcome },
        }))
        .await
    }

    /// Kills the agent process and waits for it to actually exit. Safe to
    /// call from any clone; safe to call more than once (a second call just
    /// waits on an already-dead process).
    pub async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, AcpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        if let Err(e) = self.write_line(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        match rx.await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(AcpError(format!("{method} failed: {error}"))),
            Err(_) => Err(AcpError(format!("{method}: agent connection closed before responding"))),
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), AcpError> {
        self.write_line(&json!({"jsonrpc": "2.0", "method": method, "params": params})).await
    }

    async fn write_line(&self, msg: &Value) -> Result<(), AcpError> {
        let mut line = serde_json::to_string(msg).map_err(|e| AcpError(e.to_string()))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }
}

/// Routes one line of incoming JSON from the agent: a response to a request
/// we sent (matched against `pending` by id), a request the agent is
/// sending *us* (currently only `session/request_permission` is handled;
/// anything else gets a "method not found" error reply so it doesn't hang),
/// or a notification (`session/update`; other methods are ignored).
async fn dispatch_incoming(value: Value, pending: &PendingMap, stdin: &Arc<Mutex<ChildStdin>>, tx: &mpsc::UnboundedSender<AcpEvent>) {
    if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        match value.get("id").cloned() {
            Some(id) => {
                // A request — it needs a reply, one way or another.
                if method == "session/request_permission" {
                    let _ = tx.send(AcpEvent::PermissionRequest { request_id: id, params });
                    // No reply yet — that happens later, whenever the
                    // frontend answers, via `AcpClient::respond_permission`.
                } else {
                    send_error(stdin, id, -32601, format!("method not supported by dendroid's ACP client: {method}")).await;
                }
            }
            None => {
                // A notification.
                if method == "session/update" {
                    let _ = tx.send(AcpEvent::Update(params));
                }
                // Anything else: nothing in dendroid's chat UI needs it yet.
            }
        }
        return;
    }

    // No "method" — this is a response to one of our own requests.
    let Some(id) = value.get("id").and_then(|v| v.as_i64()) else {
        return;
    };
    let Some(sender) = pending.lock().await.remove(&id) else {
        return;
    };
    let result = match value.get("error") {
        Some(error) => Err(error.clone()),
        None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = sender.send(result);
}

async fn send_error(stdin: &Arc<Mutex<ChildStdin>>, id: Value, code: i64, message: String) {
    let Ok(mut line) = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })) else {
        return;
    };
    line.push('\n');
    let mut stdin = stdin.lock().await;
    let _ = stdin.write_all(line.as_bytes()).await;
    let _ = stdin.flush().await;
}
