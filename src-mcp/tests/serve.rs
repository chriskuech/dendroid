use std::fs;
use std::sync::Arc;

use dendroid_core::native::open_native;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-mcp-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

const INIT_BODY: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"#;

async fn spawn_server(root: &std::path::Path) -> (reqwest::Client, String, CancellationToken) {
    let doc = open_native(root, "mcp-test-session").await.unwrap();
    let doc = Arc::new(Mutex::new(doc));

    let listener = dendroid_mcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ct = CancellationToken::new();

    tokio::spawn(dendroid_mcp::serve_on(doc, listener, ct.child_token()));

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
