use std::fs;
use std::sync::Arc;

use dendroid_core::native::{open_native, open_native_sql};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-mcp-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

const INIT_BODY: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"#;

async fn spawn_server(root: &std::path::Path) -> (reqwest::Client, String, CancellationToken) {
    spawn_server_with_disabled(root, Vec::new()).await
}

async fn spawn_server_with_disabled(root: &std::path::Path, disabled_tools: Vec<String>) -> (reqwest::Client, String, CancellationToken) {
    let doc = open_native(root, "mcp-test-session").await.unwrap();
    let doc = Arc::new(Mutex::new(doc));
    let sql = open_native_sql(root, "mcp-test-session").await.unwrap();
    let sql = Arc::new(Mutex::new(sql));

    let listener = dendroid_mcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ct = CancellationToken::new();

    tokio::spawn(dendroid_mcp::serve_on(doc, sql, listener, ct.child_token(), disabled_tools));

    (reqwest::Client::new(), format!("http://{addr}/mcp"), ct)
}

fn tools_call(id: i64, name: &str, arguments: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    })
}

#[tokio::test]
async fn get_outline_and_insert_round_trip_over_http() -> anyhow::Result<()> {
    let root = tmp_workspace("smoke");
    let (client, url, ct) = spawn_server(&root).await;

    let init = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(INIT_BODY)
        .send()
        .await?;
    assert_eq!(init.status(), 200);
    let session_id = init.headers().get("mcp-session-id").expect("server should assign a session id").to_str()?.to_string();

    // A fresh workspace has no headings yet.
    let outline_before = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", &session_id)
        .json(&tools_call(2, "getOutline", serde_json::json!({})))
        .send()
        .await?
        .text()
        .await?;
    assert!(outline_before.contains("[]"), "expected an empty outline, got: {outline_before}");

    let insert_response = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", &session_id)
        .json(&tools_call(3, "insert", serde_json::json!({ "id": "root", "content": "# From MCP\n\nHello.\n" })))
        .send()
        .await?
        .text()
        .await?;
    assert!(insert_response.contains("inserted"), "expected the insert tool to report success, got: {insert_response}");

    let outline_after = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", &session_id)
        .json(&tools_call(4, "getOutline", serde_json::json!({})))
        .send()
        .await?
        .text()
        .await?;
    assert!(outline_after.contains("From MCP"), "expected the new heading in the outline, got: {outline_after}");

    ct.cancel();
    Ok(())
}

#[tokio::test]
async fn db_tools_round_trip_over_http() -> anyhow::Result<()> {
    let root = tmp_workspace("db-smoke");
    let (client, url, ct) = spawn_server(&root).await;

    let init = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(INIT_BODY)
        .send()
        .await?;
    assert_eq!(init.status(), 200);
    let session_id = init.headers().get("mcp-session-id").expect("server should assign a session id").to_str()?.to_string();

    let call = |id: i64, name: &str, arguments: serde_json::Value| {
        client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-session-id", &session_id)
            .json(&tools_call(id, name, arguments))
            .send()
    };

    let create_response = call(2, "dbCreate", serde_json::json!({ "name": "Tasks" })).await?.text().await?;
    // The tool result's text content is itself a JSON string (the db id) —
    // pull it out from around the SSE/JSON-RPC framing rather than parsing
    // the whole envelope, same lightweight approach the other test uses.
    assert!(!create_response.contains("error"), "dbCreate should succeed, got: {create_response}");

    let list_response = call(3, "dbList", serde_json::json!({})).await?.text().await?;
    assert!(list_response.contains("Tasks"), "expected the new database in dbList, got: {list_response}");

    // Extract the raw id out of the dbList response well enough to use it
    // in the next call — it's the only quoted `id` field in that payload.
    let id_marker = "\\\"id\\\":\\\"";
    let start = list_response.find(id_marker).expect("dbList response should contain an id") + id_marker.len();
    let end = list_response[start..].find("\\\"").expect("id should be quoted") + start;
    let db_id = list_response[start..end].to_string();

    let create_table = call(
        4,
        "dbExec",
        serde_json::json!({ "id": db_id, "sql": "CREATE TABLE todos (title TEXT)" }),
    )
    .await?
    .text()
    .await?;
    assert!(create_table.contains("executed"), "expected dbExec to report success, got: {create_table}");

    let insert = call(
        5,
        "dbExec",
        serde_json::json!({ "id": db_id, "sql": "INSERT INTO todos (title) VALUES (?1)", "params": ["Ship it"] }),
    )
    .await?
    .text()
    .await?;
    assert!(insert.contains("executed"), "expected dbExec to report success, got: {insert}");

    let rows = call(6, "dbTableRows", serde_json::json!({ "id": db_id, "table": "todos" })).await?.text().await?;
    assert!(rows.contains("Ship it"), "expected the inserted row in dbTableRows, got: {rows}");

    ct.cancel();
    Ok(())
}

/// A skill disabled via `serve_on`'s `disabled_tools` (Settings' "Skills"
/// section, in the real app) is hidden from `tools/list` *and* rejected if
/// called anyway — the enforcement `ToolRouter::disable_route` already
/// gives every consumer of this server, including the ACP chat drawer once
/// it's wired to this same server (see `src-tauri/src/acp.rs`).
#[tokio::test]
async fn a_disabled_skill_is_hidden_from_the_tool_list_and_rejected_if_called() -> anyhow::Result<()> {
    let root = tmp_workspace("disabled-skill");
    let (client, url, ct) = spawn_server_with_disabled(&root, vec!["dbCreate".to_string()]).await;

    let init = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(INIT_BODY)
        .send()
        .await?;
    assert_eq!(init.status(), 200);
    let session_id = init.headers().get("mcp-session-id").expect("server should assign a session id").to_str()?.to_string();

    let list_response = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", &session_id)
        .json(&serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }))
        .send()
        .await?
        .text()
        .await?;
    assert!(!list_response.contains("dbCreate"), "expected dbCreate to be hidden from tools/list, got: {list_response}");
    assert!(list_response.contains("dbList"), "expected an unrelated, still-enabled tool to remain listed, got: {list_response}");

    let call_response = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", &session_id)
        .json(&tools_call(3, "dbCreate", serde_json::json!({ "name": "Should not work" })))
        .send()
        .await?
        .text()
        .await?;
    assert!(call_response.contains("error"), "expected calling a disabled skill to fail, got: {call_response}");

    ct.cancel();
    Ok(())
}
