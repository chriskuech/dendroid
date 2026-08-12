use std::fs;

use dendroid_core::native::open_native;
use loro::{ExportMode, LoroDoc, LoroList, LoroMap, LoroText};
use pollster::block_on;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A hand-built fixture doc — same loro-prosemirror-shaped encoding as
/// `ledger_roundtrip.rs`'s `fixture_doc`, extended with one `linkRef`
/// (nested inside a trailing paragraph in the *last* heading's own
/// section, since links are inline content, not a section's own wrapper
/// the way headings are — see `dendroid_core::links`). Unlike
/// `ledger_roundtrip.rs`'s helper, this one hands back the live top-level
/// `children` list and the fixture doc itself so tests can mutate it *in
/// place* afterwards (delete a heading's section, edit a title) and export
/// just that delta — the only way to exercise "a heading disappeared"
/// against the same container identities the initial import established,
/// since two independently-constructed `LoroDoc`s never share container
/// identity.
///
/// `headings` is a flat, depth-first list of `(level, id, title)` — each
/// heading's `section` nests inside the most recently seen heading whose
/// level is lower (see `dendroid_core::outline`'s doc comment for the
/// shape this builds).
struct Fixture {
    doc: LoroDoc,
    /// The document's top-level `children` list — one `section` per
    /// depth-0 (level-1-relative-to-nothing-above-it) heading passed to
    /// `fixture`.
    children: LoroList,
}

fn fixture(headings: &[(i64, &str, &str)], link_id: &str, target_id: &str) -> Fixture {
    let doc = LoroDoc::new();
    let root = doc.get_map("doc");
    root.insert("nodeName", "doc").unwrap();
    let children = root.ensure_mergeable_list("children").unwrap();

    // Stack of (level, section's own `children` list) for whichever
    // sections are still "open" — the same level-stack shape
    // `outline::outline` used to derive on read, just used here to decide
    // where each new section nests as the fixture is built.
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
        text.insert(0, title).unwrap();

        stack.push((*level, section_children));
    }

    // Body content: a paragraph holding one `@`-link, appended as a raw
    // top-level sibling (not nested inside any section) — deliberately
    // not "owned" by any heading's subtree, so it survives every heading
    // deletion these tests exercise and stays reachable via
    // `links::find_link_refs`'s whole-doc recursive walk regardless.
    // `outline::outline`'s walk (which only recognizes `section` at the
    // top level) skips right over it, same as it already skips a
    // heading's own text runs.
    let paragraph = children.insert_container(children.len(), LoroMap::new()).unwrap();
    paragraph.insert("nodeName", "paragraph").unwrap();
    let para_children = paragraph.ensure_mergeable_list("children").unwrap();
    let link = para_children.insert_container(0, LoroMap::new()).unwrap();
    link.insert("nodeName", "linkRef").unwrap();
    let link_attrs = link.ensure_mergeable_map("attributes").unwrap();
    link_attrs.insert("id", link_id).unwrap();
    link_attrs.insert("targetId", target_id).unwrap();

    doc.commit();
    Fixture { doc, children }
}

impl Fixture {
    fn snapshot(&self) -> Vec<u8> {
        self.doc.export(ExportMode::Snapshot).unwrap()
    }

    /// Finds the section whose own `id` attribute is `id`, anywhere in the
    /// tree (a section's own top-level list, or nested inside another
    /// section) — mirrors `dendroid_core::markdown`'s own `find_section`.
    fn section(&self, id: &str) -> LoroMap {
        let (list, i) = locate(&self.children, id).unwrap_or_else(|| panic!("no section with id {id}"));
        list.get(i).unwrap().into_container().unwrap().into_map().unwrap()
    }

    /// Deletes the section whose heading id is `id` (and everything nested
    /// under it) and commits, returning just the delta so it can be
    /// imported the way a real edit would arrive.
    fn delete_section(&mut self, id: &str) -> Vec<u8> {
        let before = self.doc.oplog_vv();
        let (list, i) = locate(&self.children, id).unwrap_or_else(|| panic!("no section with id {id}"));
        list.delete(i, 1).unwrap();
        self.doc.commit();
        self.doc.export(ExportMode::updates(&before)).unwrap()
    }

    /// Appends text to the heading whose id is `id`'s title.
    fn rename_heading(&mut self, id: &str, extra: &str) -> Vec<u8> {
        let before = self.doc.oplog_vv();
        let section = self.section(id);
        let section_children = section.get("children").unwrap().into_container().unwrap().into_list().unwrap();
        let heading = section_children.get(0).unwrap().into_container().unwrap().into_map().unwrap();
        let heading_children = heading.get("children").unwrap().into_container().unwrap().into_list().unwrap();
        let text = heading_children.get(0).unwrap().into_container().unwrap().into_text().unwrap();
        let len = text.len_unicode();
        text.insert(len, extra).unwrap();
        self.doc.commit();
        self.doc.export(ExportMode::updates(&before)).unwrap()
    }
}

/// Finds the `(containing list, index)` of the section whose `id`
/// attribute is `id`, searching `list` and every nested section inside it,
/// depth-first.
fn locate(list: &LoroList, id: &str) -> Option<(LoroList, usize)> {
    for i in 0..list.len() {
        let Some(entry) = list.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(node) = container.into_map() else { continue };

        let node_id = node
            .get("attributes")
            .and_then(|c| c.into_container().ok())
            .and_then(|c| c.into_map().ok())
            .and_then(|attrs| attrs.get("id"))
            .and_then(|v| v.into_value().ok())
            .and_then(|v| v.as_string().map(|s| s.to_string()));
        if node_id.as_deref() == Some(id) {
            return Some((list.clone(), i));
        }

        // Not a match at this level — a non-`section` node (the heading
        // itself, a paragraph, ...) has no further sections nested inside
        // it worth searching, but a `section`'s own `children` might hold
        // one, so keep recursing regardless of whether this node had an
        // `id` at all.
        if let Some(children) = node.get("children").and_then(|c| c.into_container().ok()).and_then(|c| c.into_list().ok()) {
            if let Some(found) = locate(&children, id) {
                return Some(found);
            }
        }
    }
    None
}

#[test]
fn single_heading_deletion_reparents_to_its_parent() {
    let root = tmp_workspace("reparent");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    // # Root / ## Child, link -> Child
    let mut fx = fixture(&[(1, "h1", "Root"), (2, "h2", "Child")], "link1", "h2");
    block_on(dendroid.import_foreign_update(&fx.snapshot())).unwrap();
    assert_eq!(dendroid.outline().unwrap().len(), 2);

    let delta = fx.delete_section("h2"); // delete "Child"'s whole section
    block_on(dendroid.import_foreign_update(&delta)).unwrap();

    let headings = dendroid.outline().unwrap();
    assert_eq!(headings.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(), ["Root"]);

    let links = dendroid.links().unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_id.as_deref(), Some("h1"), "backlink should reparent onto the deleted node's parent");
    assert!(links[0].stale_title.is_none());
}

#[test]
fn whole_subtree_deletion_skips_to_nearest_survivor() {
    let root = tmp_workspace("subtree");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    // # Root / ## Middle / ### Leaf, link -> Leaf
    let mut fx = fixture(&[(1, "h1", "Root"), (2, "h2", "Middle"), (3, "h3", "Leaf")], "link1", "h3");
    block_on(dendroid.import_foreign_update(&fx.snapshot())).unwrap();

    // Delete "Middle" (and, nested inside it, "Leaf") in one edit — e.g.
    // selecting and deleting the whole subtree at once.
    let delta = fx.delete_section("h2");
    block_on(dendroid.import_foreign_update(&delta)).unwrap();

    assert_eq!(dendroid.outline().unwrap().iter().map(|h| h.title.as_str()).collect::<Vec<_>>(), ["Root"]);

    let links = dendroid.links().unwrap();
    assert_eq!(links[0].target_id.as_deref(), Some("h1"), "should skip the also-deleted intermediate ancestor");
}

#[test]
fn deleting_everything_orphans_the_link_with_stale_title() {
    let root = tmp_workspace("orphan");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    let mut fx = fixture(&[(1, "h1", "Only Root")], "link1", "h1");
    block_on(dendroid.import_foreign_update(&fx.snapshot())).unwrap();

    let delta = fx.delete_section("h1");
    block_on(dendroid.import_foreign_update(&delta)).unwrap();

    assert!(dendroid.outline().unwrap().is_empty());

    let links = dendroid.links().unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_id, None, "nothing survives up the ancestor chain, so the link orphans");
    assert_eq!(links[0].stale_title.as_deref(), Some("Only Root"));
}

#[test]
fn rename_leaves_target_id_untouched() {
    let root = tmp_workspace("rename");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    let mut fx = fixture(&[(1, "h1", "Original Title")], "link1", "h1");
    block_on(dendroid.import_foreign_update(&fx.snapshot())).unwrap();

    let delta = fx.rename_heading("h1", " Extended");
    block_on(dendroid.import_foreign_update(&delta)).unwrap();

    let headings = dendroid.outline().unwrap();
    assert_eq!(headings[0].title, "Original Title Extended");
    assert_eq!(headings[0].id, "h1", "renaming never touches the stable id");

    let links = dendroid.links().unwrap();
    assert_eq!(links[0].target_id.as_deref(), Some("h1"), "the link keeps pointing at the (unchanged) id through a rename");
    assert!(links[0].stale_title.is_none());
}
