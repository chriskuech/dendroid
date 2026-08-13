//! Encryption's behavioral contract, mirroring `ledger_roundtrip.rs`'s
//! shape: hand-build fixture updates the same way a frontend Loro mirror
//! would produce them, drive `DendroidDocument` through `dendroid_core::
//! native::open_native`, and assert on the resulting ledger files and
//! outline. See `dendroid_core::crypto` for the key model and `doc::
//! DendroidDocument`'s `key`/`pending`/`blocked_reason` fields for the
//! "stop syncing" behavior this exercises.

use std::fs;

use dendroid_core::native::open_native;
use loro::{ExportMode, LoroDoc, LoroList, LoroMap, LoroText};
use pollster::block_on;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

// Same fixture builder as `ledger_roundtrip.rs` — see that file's comment
// for why `ensure_mergeable_*` vs `insert_container` matters here.
fn fixture_doc(headings: &[(i64, &str, &str)]) -> LoroDoc {
    let doc = LoroDoc::new();
    let root = doc.get_map("doc");
    root.insert("nodeName", "doc").unwrap();
    let children = root.ensure_mergeable_list("children").unwrap();

    let mut stack: Vec<(i64, LoroList)> = Vec::new();
    for (level, id, title) in headings {
        while stack.last().is_some_and(|(open_level, _)| *open_level >= *level) {
            stack.pop();
        }
        let parent_list = stack.last().map(|(_, list)| list.clone()).unwrap_or_else(|| children.clone());

        let section = parent_list.insert_container(parent_list.len(), LoroMap::new()).unwrap();
        section.insert("nodeName", "section").unwrap();
        let section_attrs = section.ensure_mergeable_map("attributes").unwrap();
        section_attrs.insert("id", *id).unwrap();
        let section_children = section.ensure_mergeable_list("children").unwrap();

        let heading = section_children.insert_container(0, LoroMap::new()).unwrap();
        heading.insert("nodeName", "heading").unwrap();
        let heading_attrs = heading.ensure_mergeable_map("attributes").unwrap();
        heading_attrs.insert("level", *level).unwrap();
        let heading_children = heading.ensure_mergeable_list("children").unwrap();
        let text = heading_children.insert_container(0, LoroText::new()).unwrap();
        text.insert(0, *title).unwrap();

        stack.push((*level, section_children));
    }
    doc.commit();
    doc
}

fn ledger_file_contents(root: &std::path::Path) -> String {
    let dir = root.join("ledger");
    let mut out = String::new();
    for entry in fs::read_dir(&dir).unwrap() {
        out.push_str(&fs::read_to_string(entry.unwrap().path()).unwrap());
    }
    out
}

#[test]
fn plaintext_notes_are_readable_on_disk_before_encryption_is_enabled() {
    let root = tmp_workspace("plaintext-baseline");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();
    let fixture = fixture_doc(&[(1, "h1", "Hello World")]);
    block_on(doc.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    let contents = ledger_file_contents(&root);
    assert!(contents.contains("\"update\":"));
    assert!(!contents.contains("\"enc\":"), "nothing is encrypted yet");
}

#[test]
fn enabling_encryption_encrypts_every_past_event_on_disk() {
    let root = tmp_workspace("encrypt-past");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();

    let fixture = fixture_doc(&[(1, "h1", "Secret Plans")]);
    block_on(doc.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();
    assert!(!ledger_file_contents(&root).contains("\"enc\":"));

    let (_key_text, status) = block_on(doc.generate_encryption_key()).unwrap();
    assert!(status.enabled);
    assert!(status.fingerprint.is_some());
    assert!(status.blocked_reason.is_none());

    let contents = ledger_file_contents(&root);
    assert!(contents.contains("\"enc\":"), "the pre-existing event should now be marked encrypted");
    assert!(
        !contents.contains("Secret Plans"),
        "the heading title must not appear in plaintext anywhere in the ciphertext-bearing file"
    );

    // The in-memory doc itself is unaffected by the rewrite — still
    // readable through the normal API.
    assert_eq!(doc.outline().unwrap()[0].title, "Secret Plans");
}

#[test]
fn new_events_after_enabling_are_encrypted_going_forward() {
    let root = tmp_workspace("encrypt-future");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();
    block_on(doc.generate_encryption_key()).unwrap();

    let fixture = fixture_doc(&[(1, "h1", "Written After Enabling")]);
    block_on(doc.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    let contents = ledger_file_contents(&root);
    assert!(!contents.contains("Written After Enabling"));
}

#[test]
fn a_device_with_the_right_key_decrypts_another_devices_encrypted_events() {
    let root = tmp_workspace("decrypt-with-key");

    let mut a = block_on(open_native(&root, "session-a")).unwrap();
    let (key_text, _) = block_on(a.generate_encryption_key()).unwrap();
    let fixture = fixture_doc(&[(1, "h1", "Shared Secret")]);
    block_on(a.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    // A brand-new device (fresh session, same workspace) that immediately
    // pairs with the same key — same flow "add one from a QR code" or
    // pasting the textual key drives.
    let mut b = block_on(open_native(&root, "session-b")).unwrap();
    let status = block_on(b.set_encryption_key(&key_text)).unwrap();
    assert!(status.enabled);
    assert!(status.blocked_reason.is_none());
    assert_eq!(b.outline().unwrap()[0].title, "Shared Secret");
}

#[test]
fn a_device_without_a_key_is_blocked_and_stops_syncing() {
    let root = tmp_workspace("blocked-no-key");

    let mut a = block_on(open_native(&root, "session-a")).unwrap();
    block_on(a.generate_encryption_key()).unwrap();
    let fixture = fixture_doc(&[(1, "h1", "Only For Key Holders")]);
    block_on(a.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    // A second device opens the same workspace with no key at all.
    let mut b = block_on(open_native(&root, "session-b")).unwrap();
    let status = b.encryption_status();
    assert!(!status.enabled);
    assert!(status.blocked_reason.is_some(), "an encrypted event with encryption off must block, not silently skip");
    assert!(b.outline().unwrap().is_empty(), "the encrypted content must not be visible");

    // "Stop syncing": further polling is a deliberate no-op while blocked.
    assert!(!block_on(b.poll_external()).unwrap());
}

#[test]
fn the_wrong_key_stays_blocked() {
    let root = tmp_workspace("blocked-wrong-key");

    let mut a = block_on(open_native(&root, "session-a")).unwrap();
    block_on(a.generate_encryption_key()).unwrap();
    let fixture = fixture_doc(&[(1, "h1", "Locked Content")]);
    block_on(a.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    let mut b = block_on(open_native(&root, "session-b")).unwrap();
    // A different key entirely — e.g. scanning/pasting the wrong device's
    // QR/text.
    let (_wrong_text, status) = block_on(b.generate_encryption_key()).unwrap();
    assert!(status.enabled, "b does have *a* key now");
    assert!(status.blocked_reason.is_some(), "just not the one that opens a's events");
    assert!(b.outline().unwrap().is_empty());
}

#[test]
fn supplying_the_correct_key_unblocks_and_catches_up() {
    let root = tmp_workspace("unblock");

    let mut a = block_on(open_native(&root, "session-a")).unwrap();
    let (key_text, _) = block_on(a.generate_encryption_key()).unwrap();
    let fixture = fixture_doc(&[(1, "h1", "Catch Up")]);
    block_on(a.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    let mut b = block_on(open_native(&root, "session-b")).unwrap();
    assert!(b.encryption_status().blocked_reason.is_some());
    assert!(b.outline().unwrap().is_empty());

    let status = block_on(b.set_encryption_key(&key_text)).unwrap();
    assert!(status.blocked_reason.is_none());
    assert_eq!(b.outline().unwrap()[0].title, "Catch Up");

    // Sync resumes normally afterward.
    assert!(!block_on(b.poll_external()).unwrap(), "nothing new since catching up");
}

#[test]
fn removing_the_key_leaves_past_ciphertext_untouched_and_reblocks_new_events() {
    let root = tmp_workspace("remove-key");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();
    block_on(doc.generate_encryption_key()).unwrap();

    let fixture = fixture_doc(&[(1, "h1", "Stays Encrypted Forever")]);
    block_on(doc.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();
    let contents_before = ledger_file_contents(&root);

    doc.remove_encryption_key();
    assert!(!doc.encryption_status().enabled);

    let contents_after = ledger_file_contents(&root);
    assert_eq!(contents_before, contents_after, "removing the key must not touch anything already on disk");

    // Reopening fresh (no key) now blocks on that same encrypted history.
    let reopened = block_on(open_native(&root, "session-c")).unwrap();
    assert!(reopened.encryption_status().blocked_reason.is_some());
}
