use std::fs;

use dendroid_core::native::open_native;
use loro::LoroDoc;
use pollster::block_on;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn insert_appends_content_inside_a_section() {
    let root = tmp_workspace("insert");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    block_on(dendroid.insert("root", "# Notes\n\nFirst paragraph.\n")).unwrap();
    let headings = dendroid.outline().unwrap();
    let notes_id = headings[0].id.clone();
    assert_eq!(headings[0].title, "Notes");

    block_on(dendroid.insert(&notes_id, "Second paragraph with **bold** and _italic_ text.\n")).unwrap();

    let tree = dendroid.get_tree(Some(&notes_id), 3, false, 0).unwrap();
    assert!(tree.contains("# Notes"));
    assert!(tree.contains("First paragraph."));
    assert!(tree.contains("**bold**"));
    assert!(tree.contains("_italic_"));
    assert!(
        tree.find("First paragraph").unwrap() < tree.find("Second paragraph").unwrap(),
        "insert should append after existing content, not before it:\n{tree}"
    );
}

#[test]
fn replace_content_swaps_the_whole_section_body() {
    let root = tmp_workspace("replace");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    block_on(dendroid.insert("root", "# Project\n\nOld content.\n\n## Old Child\n\nChild body.\n")).unwrap();
    let headings = dendroid.outline().unwrap();
    assert_eq!(headings.len(), 2);
    let project_id = headings[0].id.clone();

    block_on(dendroid.replace_content(&project_id, "New content only.\n")).unwrap();

    let headings = dendroid.outline().unwrap();
    assert_eq!(headings.len(), 1, "the nested subheading should be gone, replaced along with the rest of the section body");
    assert_eq!(headings[0].title, "Project", "the heading itself is untouched by `replaceContent`");

    let tree = dendroid.get_tree(Some(&project_id), 1, false, 0).unwrap();
    assert!(tree.contains("New content only."));
    assert!(!tree.contains("Old content."));
}

#[test]
fn insert_can_express_a_link_and_get_tree_can_expand_it() {
    let root = tmp_workspace("link");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    block_on(dendroid.insert("root", "# Alpha\n\nBody of alpha.\n")).unwrap();
    block_on(dendroid.insert("root", "# Beta\n\nBody of beta.\n")).unwrap();

    let headings = dendroid.outline().unwrap();
    let alpha_id = headings.iter().find(|h| h.title == "Alpha").unwrap().id.clone();
    let beta_id = headings.iter().find(|h| h.title == "Beta").unwrap().id.clone();

    block_on(dendroid.insert(&alpha_id, &format!("See also @{{{beta_id}}}.\n"))).unwrap();

    let links = dendroid.links().unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_id.as_deref(), Some(beta_id.as_str()));

    // Unexpanded: the link stays a bare reference.
    let tree = dendroid.get_tree(Some(&alpha_id), 2, false, 0).unwrap();
    assert!(tree.contains(&format!("@{{{beta_id}}}")));

    // Expanded: Beta's own body gets inlined in place of the reference.
    let expanded = dendroid.get_tree(Some(&alpha_id), 2, true, 2).unwrap();
    assert!(expanded.contains("Body of beta."), "expected the target's body inlined, got:\n{expanded}");
}

#[test]
fn get_tree_matches_a_hand_built_fixture() {
    let root = tmp_workspace("fixture");
    let mut dendroid = block_on(open_native(&root, "session-a")).unwrap();

    let fixture = LoroDoc::new();
    {
        let doc_root = fixture.get_map("doc");
        doc_root.insert("nodeName", "doc").unwrap();
        let children = doc_root.ensure_mergeable_list("children").unwrap();
        let section = children.insert_container(0, loro::LoroMap::new()).unwrap();
        section.insert("nodeName", "section").unwrap();
        let section_attrs = section.ensure_mergeable_map("attributes").unwrap();
        section_attrs.insert("id", "h1").unwrap();
        let section_children = section.ensure_mergeable_list("children").unwrap();
        let heading = section_children.insert_container(0, loro::LoroMap::new()).unwrap();
        heading.insert("nodeName", "heading").unwrap();
        let heading_attrs = heading.ensure_mergeable_map("attributes").unwrap();
        heading_attrs.insert("level", 1i64).unwrap();
        let heading_children = heading.ensure_mergeable_list("children").unwrap();
        let text = heading_children.insert_container(0, loro::LoroText::new()).unwrap();
        text.insert(0, "Fixture Heading").unwrap();
        fixture.commit();
    }
    block_on(dendroid.import_foreign_update(&fixture.export(loro::ExportMode::Snapshot).unwrap())).unwrap();

    let tree = dendroid.get_tree(None, 1, false, 0).unwrap();
    assert!(tree.starts_with("# Fixture Heading"));
}
