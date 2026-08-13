//! Exercises the full JSON-RPC dispatch loop against a tiny scripted "fake
//! agent" (a `sh -c` one-liner) rather than a real ACP-speaking binary —
//! there isn't one available in this environment to test against, but the
//! wire protocol is just newline-delimited JSON-RPC 2.0, so a shell script
//! that reads/writes fixed lines plays the agent's part well enough to
//! prove the client's request/response/notification/permission-request
//! plumbing actually works end to end.
//!
//! The script hardcodes reply ids (1, 2, 3) rather than parsing them out of
//! the incoming JSON — safe because a fresh `AcpClient` always assigns ids
//! in that exact order (`initialize`, then whatever's called first).

use std::time::Duration;

use dendroid_acp::{AcpClient, AcpEvent};
use serde_json::json;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn spawn_reports_an_error_for_a_missing_binary() {
    let result = AcpClient::spawn("dendroid-acp-test-binary-that-does-not-exist", &[], ".").await;
    assert!(result.is_err(), "expected spawning a nonexistent command to fail");
}

#[tokio::test]
async fn full_turn_round_trip_including_a_permission_request() {
    // id 1: initialize (sent by `AcpClient::spawn` itself)
    // id 2: session/new
    // id 3: session/prompt — mid-turn the script also sends a
    //       `session/request_permission` *request* of its own (id 100,
    //       chosen well clear of our own counter) before finally replying
    //       to id 3.
    let script = r#"
        IFS= read -r _line1
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}'
        IFS= read -r _line2
        printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1"}}'
        IFS= read -r _line3
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":100,"method":"session/request_permission","params":{"sessionId":"sess-1","options":[{"optionId":"allow","name":"Allow"}]}}'
        IFS= read -r _line4
        printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
    "#;

    let (client, mut events) = timeout(TIMEOUT, AcpClient::spawn("sh", &["-c".to_string(), script.to_string()], "."))
        .await
        .expect("spawn timed out")
        .expect("spawn failed");

    let session_id = timeout(TIMEOUT, client.new_session(".")).await.expect("new_session timed out").expect("new_session failed");
    assert_eq!(session_id, "sess-1");

    let prompt_client = client.clone();
    let prompt_session = session_id.clone();
    let prompt_task = tokio::spawn(async move { prompt_client.prompt(&prompt_session, "hello").await });

    // Drain events until we've seen both the streamed chunk and the
    // permission request, answering the latter as soon as it arrives —
    // exactly what `src-tauri/src/acp.rs`'s forwarding task plus the
    // frontend's response round trip do together in the real app.
    let mut saw_update = false;
    let mut saw_permission = false;
    while !(saw_update && saw_permission) {
        let event = timeout(TIMEOUT, events.recv()).await.expect("timed out waiting for an event").expect("event channel closed early");
        match event {
            AcpEvent::Update(params) => {
                assert_eq!(params["update"]["sessionUpdate"], "agent_message_chunk");
                saw_update = true;
            }
            AcpEvent::PermissionRequest { request_id, params } => {
                assert_eq!(params["options"][0]["optionId"], "allow");
                client
                    .respond_permission(request_id, json!({"outcome": "selected", "optionId": "allow"}))
                    .await
                    .expect("respond_permission failed");
                saw_permission = true;
            }
            AcpEvent::Closed { error } => panic!("agent closed unexpectedly: {error:?}"),
        }
    }

    let result = timeout(TIMEOUT, prompt_task).await.expect("prompt timed out").expect("prompt task panicked").expect("prompt failed");
    assert_eq!(result["stopReason"], "end_turn");

    client.shutdown().await;
}
