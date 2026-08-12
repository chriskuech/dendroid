use std::fs;

use dendroid_core::native::open_native;
use loro::{ExportMode, LoroDoc, LoroList, LoroMap, LoroText};
use pollster::block_on;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

// Builds a document shaped exactly the way `loro-prosemirror`'s default
// (unbound) binding encodes a ProseMirror doc — see
// `dendroid_core::outline` for why this is the contract, and
// `loro-prosemirror`'s `src/lib.ts` for the source of truth. Standing in
// here for what would, in production, arrive as update bytes exported
// from the frontend's own LoroDoc mirror.
//
// `headings` is a flat, depth-first `(level, id, title)` list — each
// heading's `section` nests inside the most recently seen heading whose
// level is lower, exactly the hierarchy `outline::outline` derives from
// the *same* nesting on read (see that module's doc comment).
fn fixture_doc(headings: &[(i64, &str, &str)]) -> LoroDoc {
    let doc = LoroDoc::new();
    let root = doc.get_map("doc");
    root.insert("nodeName", "doc").unwrap();
    // `ensure_mergeable_list`/`_map`, not `insert_container`: this mirrors
    // loro-prosemirror's own `getOrCreateContainer` (see `getLoroMapChildren`
    // in its source), which matters when two peers each open a brand-new,
    // previously-empty document and *both* lazily initialize the same
    // "doc" root independently. `insert_container` has replacement
    // semantics — two concurrent inserts under the same map key means one
    // wins and the other's content is orphaned. `ensure_mergeable_*`
    // containers merge instead, which is exactly what's needed here.
    let children = root.ensure_mergeable_list("children").unwrap();

    // Stack of (level, that section's own `children` list) for whichever
    // sections are still "open" — decides where each new section nests.
    let mut stack: Vec<(i64, LoroList)> = Vec::new();

    for (level, id, title) in headings {
        while stack.last().is_some_and(|(open_level, _)| *open_level >= *level) {
            stack.pop();
        }
        let parent_list = stack.last().map(|(_, list)| list.clone()).unwrap_or_else(|| children.clone());

        // A brand-new list *item* at a given position isn't a contested
        // shared slot the way a map key is, so plain `insert_container` —
        // matching loro-prosemirror's own `createLoroMap`/`createLoroText`,
        // used for newly-added nodes — is correct here.
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
fn outline_reconstructs_implicit_nesting_from_heading_levels() {
    let root = tmp_workspace("outline");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    // # Project Ideas / ## Dendroid / ## Another Idea / # Second Root
    let fixture = fixture_doc(&[
        (1, "h1", "Project Ideas"),
        (2, "h2", "Dendroid"),
        (2, "h3", "Another Idea"),
        (1, "h4", "Second Root"),
    ]);
    let update = fixture.export(ExportMode::Snapshot).unwrap();
    block_on(dendroid.import_foreign_update(&update)).unwrap();

    let headings = dendroid.outline().unwrap();
    assert_eq!(headings.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(), [
        "Project Ideas",
        "Dendroid",
        "Another Idea",
        "Second Root",
    ]);

    let dendroid_node = &headings[1];
    assert_eq!(dendroid_node.parent.as_deref(), Some("h1"));
    assert_eq!(dendroid_node.depth, 1);
    assert_eq!(dendroid_node.level, 2);
    assert_eq!(dendroid_node.index, 0);

    let another_idea = &headings[2];
    assert_eq!(another_idea.parent.as_deref(), Some("h1"));
    assert_eq!(another_idea.index, 1, "second child of h1, not a sibling reset");

    let second_root = &headings[3];
    assert_eq!(second_root.parent, None, "level-1 heading closes the previous level-1's subtree");
    assert_eq!(second_root.depth, 0);
}

#[test]
fn replay_reconstructs_state_after_reopen() {
    let root = tmp_workspace("replay");

    {
        let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();
        let fixture = fixture_doc(&[(1, "h1", "Project Ideas")]);
        let update = fixture.export(ExportMode::Snapshot).unwrap();
        block_on(dendroid.import_foreign_update(&update)).unwrap();
    }

    // Fresh process, fresh session id, same workspace: state must come
    // entirely from replaying the ledger files on disk.
    let reopened = block_on(open_native(&root, "session-b")).unwrap();
    let headings = reopened.outline().unwrap();
    assert_eq!(headings.len(), 1);
    assert_eq!(headings[0].title, "Project Ideas");
}

#[test]
fn ledger_filename_matches_date_and_session_convention() {
    let root = tmp_workspace("filename");
    let doc = block_on(open_native(&root, "my-session-id")).unwrap();

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    assert_eq!(doc.ledger_name(), format!("{today}.my-session-id.log"));
}

#[test]
fn ledger_file_lands_under_workspace_root_ledger_dir() {
    let root = tmp_workspace("layout");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();

    let fixture = fixture_doc(&[(1, "h1", "Project Ideas")]);
    block_on(doc.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    let path = root.join("ledger").join(doc.ledger_name());
    assert!(path.exists(), "expected ledger file at {}", path.display());
}

#[test]
fn concurrent_sessions_merge_via_poll_external() {
    let root = tmp_workspace("merge");

    let mut a = block_on(open_native(&root, "session-a")).unwrap();
    let mut b = block_on(open_native(&root, "session-b")).unwrap();

    let from_a = fixture_doc(&[(1, "from-a", "From A")]);
    block_on(a.import_foreign_update(&from_a.export(ExportMode::Snapshot).unwrap())).unwrap();

    let from_b = fixture_doc(&[(1, "from-b", "From B")]);
    block_on(b.import_foreign_update(&from_b.export(ExportMode::Snapshot).unwrap())).unwrap();

    // Neither has seen the other's write yet.
    assert_eq!(a.outline().unwrap().len(), 1);
    assert_eq!(b.outline().unwrap().len(), 1);

    assert!(block_on(a.poll_external()).unwrap(), "a should observe b's ledger file");
    assert!(block_on(b.poll_external()).unwrap(), "b should observe a's ledger file");

    let a_titles: Vec<_> = a.outline().unwrap().into_iter().map(|h| h.title).collect();
    let b_titles: Vec<_> = b.outline().unwrap().into_iter().map(|h| h.title).collect();
    assert_eq!(a_titles.len(), 2);
    assert!(a_titles.contains(&"From A".to_string()) && a_titles.contains(&"From B".to_string()));
    assert!(a_titles.iter().all(|t| b_titles.contains(t)));
}

#[test]
fn frontend_broadcast_ships_only_the_delta() {
    let root = tmp_workspace("broadcast");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();

    let snapshot = doc.export_snapshot_for_bootstrap().unwrap();
    assert!(!snapshot.is_empty(), "even an empty doc's snapshot has framing bytes");

    // Nothing changed since the snapshot: no delta to send.
    assert!(doc.export_updates_for_frontend().unwrap().is_none());

    let fixture = fixture_doc(&[(1, "h1", "New Heading")]);
    block_on(doc.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    let delta = doc.export_updates_for_frontend().unwrap().expect("a delta after mutating");
    assert!(!delta.is_empty());
    // Second call after no further changes: nothing new.
    assert!(doc.export_updates_for_frontend().unwrap().is_none());
}

#[test]
fn import_from_frontend_does_not_echo_back_to_its_own_source() {
    // Regression test for the bug where every keystroke in the Tauri app
    // came back out over `crdt://update` to the same window that made it —
    // `loro-prosemirror` can't tell that echo apart from a real remote
    // change, so it tore down and rebuilt the whole ProseMirror document
    // on every edit (see `doc_import_update`'s doc comment). Unlike
    // `import_foreign_update` (a genuinely external source, still expected
    // to surface through `export_updates_for_frontend`), `import_from_
    // frontend` must leave nothing for that same frontend to receive back.
    let root = tmp_workspace("no-self-echo");
    let mut doc = block_on(open_native(&root, "session-a")).unwrap();
    doc.export_snapshot_for_bootstrap().unwrap();

    let fixture = fixture_doc(&[(2, "h1", "New Heading")]);
    block_on(doc.import_from_frontend(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();

    assert!(
        doc.export_updates_for_frontend().unwrap().is_none(),
        "the frontend that sent this update must not receive it back as if it were new"
    );
}
