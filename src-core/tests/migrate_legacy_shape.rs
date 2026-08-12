use std::fs;

use dendroid_core::native::open_native;
use loro::{ExportMode, LoroDoc, LoroMap, LoroText};
use pollster::block_on;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// The *old* (pre-`section`-nesting) flat encoding — headings as top-level
/// siblings, hierarchy inferred purely from level, `id` on the heading
/// itself rather than a wrapping `section`. What every ledger file
/// predating `dendroid_core::migrate` actually contains on disk.
fn legacy_fixture(headings: &[(i64, &str, &str)]) -> LoroDoc {
    let doc = LoroDoc::new();
    let root = doc.get_map("doc");
    root.insert("nodeName", "doc").unwrap();
    let children = root.ensure_mergeable_list("children").unwrap();

    for (i, (level, id, title)) in headings.iter().enumerate() {
        let heading = children.insert_container(i, LoroMap::new()).unwrap();
        heading.insert("nodeName", "heading").unwrap();
        let attrs = heading.ensure_mergeable_map("attributes").unwrap();
        attrs.insert("level", *level).unwrap();
        attrs.insert("id", *id).unwrap();
        let heading_children = heading.ensure_mergeable_list("children").unwrap();
        let text = heading_children.insert_container(0, LoroText::new()).unwrap();
        text.insert(0, *title).unwrap();
    }

    // Trailing body content — belongs (per the old level-based grouping
    // rule) to whichever heading is last, here "Second Root": a paragraph
    // with one bold span, to exercise the migration's mark round-trip too.
    let children = doc.get_map("doc").get("children").unwrap().into_container().unwrap().into_list().unwrap();
    let paragraph = children.insert_container(children.len(), LoroMap::new()).unwrap();
    paragraph.insert("nodeName", "paragraph").unwrap();
    let para_children = paragraph.ensure_mergeable_list("children").unwrap();
    let text = para_children.insert_container(0, LoroText::new()).unwrap();
    text.insert(0, "Body of the second root.").unwrap();
    text.mark(0..4, "bold", true).unwrap();

    doc.commit();
    doc
}

#[test]
fn legacy_flat_ledger_migrates_to_nested_sections_on_open() {
    let root = tmp_workspace("migrate");

    {
        // Simulates a workspace whose ledger already has content recorded
        // in the old flat shape, from before this app version existed.
        let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();
        // # Project Ideas / ## Dendroid / ## Another Idea / # Second Root
        let fixture = legacy_fixture(&[
            (1, "h1", "Project Ideas"),
            (2, "h2", "Dendroid"),
            (2, "h3", "Another Idea"),
            (1, "h4", "Second Root"),
        ]);
        block_on(dendroid.import_foreign_update(&fixture.export(ExportMode::Snapshot).unwrap())).unwrap();
        // `dendroid`'s own `open` already ran (and found nothing to
        // migrate) before this import landed — this session never sees
        // the old shape get upgraded, only the next one that calls `open`
        // against this same ledger does.
    }

    // Fresh process, fresh session id, same workspace: `open` replays the
    // ledger (still containing the old flat shape from session-a) and
    // must migrate it before returning.
    let migrated = block_on(open_native(&root, "session-b")).unwrap();

    let headings = migrated.outline().unwrap();
    assert_eq!(
        headings.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(),
        ["Project Ideas", "Dendroid", "Another Idea", "Second Root"],
        "migration must not lose, reorder, or duplicate any heading"
    );

    // Hierarchy survives the migration exactly as the old level-inferred
    // shape implied it — same assertions `ledger_roundtrip.rs`'s
    // `outline_reconstructs_implicit_nesting_from_heading_levels` makes
    // against the *unmigrated* shape, now checked against the migrated one.
    assert_eq!(headings[1].parent.as_deref(), Some("h1"));
    assert_eq!(headings[1].depth, 1);
    assert_eq!(headings[1].id, "h2", "ids (what `@`-links address) survive the migration unchanged");
    assert_eq!(headings[2].parent.as_deref(), Some("h1"));
    assert_eq!(headings[2].index, 1, "second child of h1, not a sibling reset");
    assert_eq!(headings[3].parent, None, "level-1 heading closes the previous level-1's subtree");
    assert_eq!(headings[3].depth, 0);

    // Body content (and its mark) migrated along with its enclosing
    // heading, nested inside the now-`section`-wrapped "Second Root".
    let tree = migrated.get_tree(None, 3, false, 0).unwrap();
    assert!(tree.contains("# Project Ideas"));
    assert!(tree.contains("## Dendroid"));
    assert!(tree.contains("## Another Idea"));
    assert!(tree.contains("# Second Root"));
    assert!(tree.contains("**Body**"), "the bold mark on \"Body\" must survive the migration:\n{tree}");
    assert!(tree.contains("**Body** of the second root."), "and land under \"Second Root\", not elsewhere:\n{tree}");

    // The migration itself is recorded as an ordinary ledger append
    // (during session-b's own `open`) — a third open against the
    // now-migrated ledger is a no-op and sees the identical outline.
    let reopened_again = block_on(open_native(&root, "session-c")).unwrap();
    assert_eq!(
        reopened_again.outline().unwrap().iter().map(|h| h.title.clone()).collect::<Vec<_>>(),
        headings.iter().map(|h| h.title.clone()).collect::<Vec<_>>(),
    );
}
