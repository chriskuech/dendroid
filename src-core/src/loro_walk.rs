//! Low-level accessors over the loro-prosemirror node encoding
//! (`nodeName`/`attributes`/`children` — see `crate::outline`'s doc comment
//! for the contract this depends on), shared by every module that needs to
//! walk the document: `outline` and `markdown` (recurse into `section`
//! nesting), `migrate` (reads the pre-migration flat shape once), and
//! `links` (recurses into inline content, since `linkRef` nodes live
//! nested inside paragraphs/list items/etc., not just inside `section`s).

use loro::{Container, LoroDoc, LoroList, LoroMap, ValueOrContainer};

use crate::error::Result;

/// Root container name loro-prosemirror uses for its default (unbound)
/// binding — see `loro-prosemirror`'s `ROOT_DOC_KEY`.
pub(crate) const DOC_ROOT: &str = "doc";
pub(crate) const KEY_NODE_NAME: &str = "nodeName";
pub(crate) const KEY_ATTRIBUTES: &str = "attributes";
pub(crate) const KEY_CHILDREN: &str = "children";
/// Custom attribute both `section` and `linkRef` nodes carry for stable
/// identity — see `dendroid_core::outline`'s doc comment. (A `heading`
/// itself no longer carries one — see `outline`'s doc comment for why
/// identity moved to the `section` that wraps it.)
pub(crate) const ATTR_ID: &str = "id";
/// Wraps a heading and everything nested under it (body content, and
/// further nested `section`s for subheadings) into one addressable
/// container — see `crate::outline`'s doc comment for the shape this
/// makes possible.
pub(crate) const SECTION_NODE_NAME: &str = "section";

pub(crate) fn root(doc: &LoroDoc) -> LoroMap {
    doc.get_map(DOC_ROOT)
}

/// Recursively visits every node in the tree rooted at `node` (itself
/// included), depth-first, in document order. Unlike a walk over just
/// `node`'s own `children`, this follows *every* level of nesting — needed
/// because, unlike headings (always top-level siblings), a node like
/// `linkRef` can live nested arbitrarily deep in inline content (inside a
/// paragraph, inside a list item, ...).
pub(crate) fn walk_nodes(node: &LoroMap, visit: &mut impl FnMut(&LoroMap) -> Result<()>) -> Result<()> {
    visit(node)?;
    if let Some(children) = get_list(node, KEY_CHILDREN)? {
        for i in 0..children.len() {
            let Some(entry) = children.get(i) else { continue };
            let Ok(container) = entry.into_container() else { continue }; // a LoroText run
            let Ok(child) = container.into_map() else { continue };
            walk_nodes(&child, visit)?;
        }
    }
    Ok(())
}

pub(crate) fn get_list(map: &LoroMap, key: &str) -> Result<Option<LoroList>> {
    Ok(get_container(map, key)?.and_then(|c| c.into_list().ok()))
}

pub(crate) fn get_map(map: &LoroMap, key: &str) -> Result<Option<LoroMap>> {
    Ok(get_container(map, key)?.and_then(|c| c.into_map().ok()))
}

pub(crate) fn get_container(map: &LoroMap, key: &str) -> Result<Option<Container>> {
    Ok(map.get(key).and_then(|v: ValueOrContainer| v.into_container().ok()))
}

pub(crate) fn get_string(map: &LoroMap, key: &str) -> Result<Option<String>> {
    Ok(map.get(key).and_then(|v| v.into_value().ok()).and_then(|v| v.as_string().map(|s| s.to_string())))
}

pub(crate) fn get_i64(map: &LoroMap, key: &str) -> Result<Option<i64>> {
    Ok(map.get(key).and_then(|v| v.into_value().ok()).and_then(|v| v.as_i64().copied()))
}
