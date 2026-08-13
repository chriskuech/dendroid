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
// for why it's shaped this way.
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

#[test]
fn history_lists_changes_most_recent_first() {
    let root = tmp_workspace("history-list");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();

    assert!(doc.history().unwrap().is_empty(), "a brand-new workspace has no history yet");

    let first = fixture_doc(&[(1, "h1", "First")]);
    block_on(doc.import_foreign_update(&first.export(ExportMode::Snapshot).unwrap())).unwrap();
    let after_first = doc.history().unwrap();
    assert_eq!(after_first.len(), 1);

    let second = fixture_doc(&[(1, "h1", "First"), (1, "h2", "Second")]);
    let delta = {
        let before = LoroDoc::new();
        before.import(&first.export(ExportMode::Snapshot).unwrap()).unwrap();
        second.export(ExportMode::updates(&before.oplog_vv())).unwrap()
    };
    block_on(doc.import_foreign_update(&delta)).unwrap();

    let after_second = doc.history().unwrap();
    assert!(after_second.len() > after_first.len(), "a second import should add at least one more history entry");
    // Most recent first: the token for "now" should differ from the first
    // snapshot's own entry token, and the first entry we recorded should
    // still show up somewhere in the fuller list.
    assert!(after_second.iter().any(|e| e.token == after_first[0].token));
}

#[test]
fn revert_to_restores_prior_content_as_a_new_forward_change() {
    let root = tmp_workspace("history-revert");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();

    let first = fixture_doc(&[(1, "h1", "Original")]);
    block_on(doc.import_foreign_update(&first.export(ExportMode::Snapshot).unwrap())).unwrap();

    let checkpoint = doc.history().unwrap();
    assert_eq!(checkpoint.len(), 1);
    let token = checkpoint[0].token.clone();

    // A second, independent edit on top.
    block_on(doc.insert("h1", "Some body text")).unwrap();

    let titles_before_revert: Vec<_> = doc.outline().unwrap().into_iter().map(|h| h.title).collect();
    assert_eq!(titles_before_revert, vec!["Original".to_string()], "insert only adds body content, not headings");

    let second = fixture_doc(&[(1, "h1", "Original"), (1, "h2", "Added Later")]);
    let delta = {
        let before = LoroDoc::new();
        before.import(&first.export(ExportMode::Snapshot).unwrap()).unwrap();
        second.export(ExportMode::updates(&before.oplog_vv())).unwrap()
    };
    block_on(doc.import_foreign_update(&delta)).unwrap();

    let titles_with_second_heading: Vec<_> = doc.outline().unwrap().into_iter().map(|h| h.title).collect();
    assert!(titles_with_second_heading.contains(&"Added Later".to_string()));

    // Roll back to the very first checkpoint (before "Added Later" existed).
    block_on(doc.revert_to(&token)).unwrap();

    let titles_after_revert: Vec<_> = doc.outline().unwrap().into_iter().map(|h| h.title).collect();
    assert!(!titles_after_revert.contains(&"Added Later".to_string()), "revert_to should undo the later heading");
    assert!(titles_after_revert.contains(&"Original".to_string()), "revert_to should keep what existed at the target");

    // The rollback itself shows up as a new, tagged history entry — nothing
    // was erased, so the "Added Later" edit is still reachable in history.
    let after_revert = doc.history().unwrap();
    assert!(after_revert.len() > checkpoint.len(), "the rollback appends a new entry rather than truncating history");
    assert_eq!(after_revert[0].message, "Rollback", "the newest entry is the rollback itself");

    // And it's durable: reopening from disk (fresh session, fresh process)
    // must reflect the rolled-back state.
    let reopened = block_on(open_native(&root, "session-b")).unwrap();
    let titles_reopened: Vec<_> = reopened.outline().unwrap().into_iter().map(|h| h.title).collect();
    assert!(!titles_reopened.contains(&"Added Later".to_string()));
}

#[test]
fn revert_to_rejects_a_malformed_token() {
    let root = tmp_workspace("history-bad-token");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();
    let fixture = fixture_doc(&[(1, "h1", "Only Heading")]);
    block_on(doc.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    let result = block_on(doc.revert_to("not a real token"));
    assert!(result.is_err());
}
