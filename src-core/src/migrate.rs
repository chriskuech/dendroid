//! One-time upgrade from the old flat document shape (every heading a
//! top-level sibling, hierarchy inferred by comparing levels — what
//! `outline`/`markdown` used to assume) to the current shape, where a
//! heading and everything nested under it are wrapped together in one
//! `section` node (see `outline`'s doc comment for why). Called once per
//! `DendroidDocument::open` (`doc::migrate_legacy_shape`) — a cheap no-op
//! check for any workspace already on the new shape, or a brand-new one.
//!
//! This is a squash, not a rename: since Loro has no "move this existing
//! container under a new parent, keeping its identity" primitive (only
//! insert/delete), migrating means reading the old nodes and rebuilding
//! equivalent fresh ones nested inside new `section` wrappers — the same
//! already-accepted trade-off `markdown::ApplyMode::Replace` makes for
//! replaced content (moved content starts a new edit history from this
//! point on; nothing *visible* — title text, body content, heading ids,
//! `@`-link targets — is lost).

use loro::{LoroDoc, LoroList, LoroMap, LoroText, TextDelta};

use crate::error::Result;
use crate::loro_walk::{
    get_i64, get_list, get_map, get_string, root, ATTR_ID, KEY_ATTRIBUTES, KEY_CHILDREN, KEY_NODE_NAME, SECTION_NODE_NAME,
};

const HEADING_NODE_NAME: &str = "heading";

/// True if `doc`'s top-level children contain a bare `heading` — the old
/// shape's tell (the current shape only ever has `section` wrappers
/// there, never a `heading` directly).
pub(crate) fn needs_migration(doc: &LoroDoc) -> Result<bool> {
    let Some(children) = top_children(doc)? else {
        return Ok(false);
    };
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(node) = container.into_map() else { continue };
        if get_string(&node, KEY_NODE_NAME)?.as_deref() == Some(HEADING_NODE_NAME) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn top_children(doc: &LoroDoc) -> Result<Option<LoroList>> {
    get_list(&root(doc), KEY_CHILDREN)
}

/// Rebuilds `doc`'s top-level `children` from the old flat shape into
/// nested `section`s, grouping each heading with the siblings that follow
/// it up to (not including) the next heading at or above its level —
/// exactly the rule the old (pre-nesting) `markdown::subtree_range`
/// applied on every read, just run once here and made permanent.
pub(crate) fn migrate_flat_to_sections(doc: &LoroDoc) -> Result<()> {
    let doc_root = root(doc);
    let Some(old_children) = top_children(doc)? else { return Ok(()) };

    let mut old_items = Vec::with_capacity(old_children.len());
    for i in 0..old_children.len() {
        let Some(entry) = old_children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(node) = container.into_map() else { continue };
        old_items.push(node);
    }

    // Read every old item before touching `doc_root`'s own `children` key
    // — `insert_container` below points that key at a brand-new list,
    // but `old_children`/`old_items`' own handles stay valid regardless,
    // since nothing deletes the containers they refer to.
    let new_children = doc_root.insert_container(KEY_CHILDREN, LoroList::new())?;
    write_sections_from(&new_children, &old_items)?;
    Ok(())
}

/// Groups `items` (old flat top-level siblings) into `dst`, wrapping each
/// heading — and everything up to the next heading at or above its own
/// level — in a fresh `section`. Non-heading items before any heading (a
/// pre-existing, already-unsupported edge case — the outline never
/// addressed top-of-document content before the first heading either) are
/// copied through unwrapped, same position, so nothing just disappears.
fn write_sections_from(dst: &LoroList, items: &[LoroMap]) -> Result<()> {
    let mut i = 0;
    while i < items.len() {
        let node = &items[i];
        if get_string(node, KEY_NODE_NAME)?.as_deref() != Some(HEADING_NODE_NAME) {
            copy_node(dst, dst.len(), node)?;
            i += 1;
            continue;
        }

        let level = heading_level(node)?;
        let mut end = items.len();
        for (j, item) in items.iter().enumerate().skip(i + 1) {
            if get_string(item, KEY_NODE_NAME)?.as_deref() == Some(HEADING_NODE_NAME) && heading_level(item)? <= level {
                end = j;
                break;
            }
        }

        let section = dst.insert_container(dst.len(), LoroMap::new())?;
        section.insert(KEY_NODE_NAME, SECTION_NODE_NAME)?;
        let section_attrs = section.ensure_mergeable_map(KEY_ATTRIBUTES)?;
        let old_id = get_map(node, KEY_ATTRIBUTES)?.and_then(|a| get_string(&a, ATTR_ID).ok().flatten());
        section_attrs.insert(ATTR_ID, old_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()).as_str())?;
        let section_children = section.ensure_mergeable_list(KEY_CHILDREN)?;

        // The heading itself, minus its old `id` (identity moved to the
        // section that now wraps it — see `outline`'s doc comment).
        copy_node_without_id(&section_children, 0, node)?;
        write_sections_from(&section_children, &items[i + 1..end])?;

        i = end;
    }
    Ok(())
}

fn heading_level(node: &LoroMap) -> Result<u8> {
    Ok(get_map(node, KEY_ATTRIBUTES)?.and_then(|a| get_i64(&a, "level").ok().flatten()).unwrap_or(1).clamp(1, 255) as u8)
}

/// Deep-copies `src` (a whole node subtree — `nodeName`, `attributes`,
/// `children`, recursively) into a fresh container at `dst[at]`. Generic
/// over node type: the encoding is uniform (`outline`'s doc comment), so
/// nothing here needs to know paragraph from list from code block.
fn copy_node(dst: &LoroList, at: usize, src: &LoroMap) -> Result<()> {
    let node = dst.insert_container(at, LoroMap::new())?;
    if let Some(name) = get_string(src, KEY_NODE_NAME)? {
        node.insert(KEY_NODE_NAME, name.as_str())?;
    }
    if let Some(src_attrs) = get_map(src, KEY_ATTRIBUTES)? {
        let dst_attrs = node.ensure_mergeable_map(KEY_ATTRIBUTES)?;
        copy_attrs(&src_attrs, &dst_attrs)?;
    }
    if let Some(src_children) = get_list(src, KEY_CHILDREN)? {
        let dst_children = node.ensure_mergeable_list(KEY_CHILDREN)?;
        copy_children(&dst_children, &src_children)?;
    }
    Ok(())
}

/// Same as `copy_node`, but drops the copied node's own `id` attribute —
/// used only for a section's leading `heading`, whose old top-level `id`
/// moved to the `section` now wrapping it.
fn copy_node_without_id(dst: &LoroList, at: usize, src: &LoroMap) -> Result<()> {
    let node = dst.insert_container(at, LoroMap::new())?;
    if let Some(name) = get_string(src, KEY_NODE_NAME)? {
        node.insert(KEY_NODE_NAME, name.as_str())?;
    }
    if let Some(src_attrs) = get_map(src, KEY_ATTRIBUTES)? {
        let dst_attrs = node.ensure_mergeable_map(KEY_ATTRIBUTES)?;
        for key in src_attrs.keys() {
            if key.as_str() == ATTR_ID {
                continue;
            }
            if let Some(value) = src_attrs.get(key.as_str()).and_then(|v| v.into_value().ok()) {
                dst_attrs.insert(key.as_str(), value)?;
            }
        }
    }
    if let Some(src_children) = get_list(src, KEY_CHILDREN)? {
        let dst_children = node.ensure_mergeable_list(KEY_CHILDREN)?;
        copy_children(&dst_children, &src_children)?;
    }
    Ok(())
}

fn copy_attrs(src: &LoroMap, dst: &LoroMap) -> Result<()> {
    for key in src.keys() {
        if let Some(value) = src.get(key.as_str()).and_then(|v| v.into_value().ok()) {
            dst.insert(key.as_str(), value)?;
        }
    }
    Ok(())
}

fn copy_children(dst: &LoroList, src: &LoroList) -> Result<()> {
    for i in 0..src.len() {
        let Some(entry) = src.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        if let Ok(text) = container.clone().into_text() {
            copy_text(dst, &text)?;
            continue;
        }
        let Ok(node) = container.into_map() else { continue };
        copy_node(dst, dst.len(), &node)?;
    }
    Ok(())
}

/// Copies a `LoroText` run's plain text and its per-span marks — same
/// insert-everything-first-then-mark two-pass shape `markdown::
/// write_inline` uses, for the same reason: Loro's marks default to an
/// "after" expand policy, so marking span N before span N+1's text exists
/// would make N+1 wrongly inherit N's marks the moment it's inserted.
fn copy_text(dst: &LoroList, src: &LoroText) -> Result<()> {
    let deltas = src.to_delta();
    let full: String = deltas
        .iter()
        .filter_map(|d| {
            let TextDelta::Insert { insert, .. } = d else { return None };
            Some(insert.as_str())
        })
        .collect();

    let new_text = dst.insert_container(dst.len(), LoroText::new())?;
    new_text.insert(0, &full)?;

    let mut offset = 0usize;
    for delta in &deltas {
        let TextDelta::Insert { insert, attributes } = delta else { continue };
        let len = insert.chars().count();
        if let Some(attrs) = attributes {
            for (key, value) in attrs.iter() {
                new_text.mark(offset..offset + len, key, value.clone())?;
            }
        }
        offset += len;
    }
    Ok(())
}
