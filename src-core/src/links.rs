//! `@`-links: the `linkRef` node type, and reconciling backlinks when a
//! heading they target disappears from the document.
//!
//! Unlike `section`, `linkRef` is inline content — typed mid-sentence like
//! a mention — so it can live nested arbitrarily deep inside a paragraph,
//! a list item, a blockquote, and so on, rather than only ever wrapping a
//! heading and its body the way a `section` does (see `crate::outline`'s
//! doc comment). Finding every one of them means recursing into every
//! node's `children`, headings' bodies included — that's what
//! `loro_walk::walk_nodes` is for.

use std::collections::HashMap;

use loro::{LoroDoc, LoroMap};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::loro_walk::{get_map, get_string, root, walk_nodes, ATTR_ID, KEY_ATTRIBUTES, KEY_NODE_NAME};
use crate::outline::HeadingDto;

pub(crate) const LINK_NODE_NAME: &str = "linkRef";
pub(crate) const ATTR_TARGET_ID: &str = "targetId";
/// Stamped onto a link whose entire ancestor chain got deleted at once —
/// there's no surviving heading left to reparent onto, so `targetId` is
/// cleared and the last known title is kept here instead, purely so the UI
/// has something to show ("~~Deleted heading~~") rather than nothing.
pub(crate) const ATTR_STALE_TITLE: &str = "staleTitle";

/// A `linkRef` node, flat (no positional/nesting info) — what backlink
/// reconciliation needs: every link's own id and whatever it currently
/// targets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRefDto {
    pub id: String,
    /// `None` once orphaned (see `ATTR_STALE_TITLE`).
    pub target_id: Option<String>,
    pub stale_title: Option<String>,
}

/// A `linkRef` node with its position in the outline — what
/// `outline::outline_with_links` interleaves alongside headings for the
/// tree view: nested under whichever heading currently encloses it
/// (`parent`), at that heading's depth plus one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEntryDto {
    pub id: String,
    pub target_id: Option<String>,
    pub stale_title: Option<String>,
    pub parent: Option<String>,
    pub depth: u32,
}

/// Every `linkRef` node in the document, in document order. Used by tests
/// and by backlink reconciliation's read side; the live UI reads the
/// positional `LinkEntryDto` form instead (`outline::outline_with_links`).
pub fn find_link_refs(doc: &LoroDoc) -> Result<Vec<LinkRefDto>> {
    let mut out = Vec::new();
    walk_nodes(&root(doc), &mut |node| {
        if let Some(dto) = read_link(node)? {
            out.push(dto);
        }
        Ok(())
    })?;
    Ok(out)
}

/// Finds every `linkRef` nested anywhere inside `node` (`node` itself
/// included) and appends a positioned `LinkEntryDto` for each, in document
/// order — used by `outline::outline_with_links` once per top-level
/// non-heading sibling, filed under whichever heading currently encloses
/// it.
pub(crate) fn collect_link_entries(node: &LoroMap, parent: Option<&str>, depth: u32, out: &mut Vec<LinkEntryDto>) -> Result<()> {
    walk_nodes(node, &mut |n| {
        if let Some(link) = read_link(n)? {
            out.push(LinkEntryDto {
                id: link.id,
                target_id: link.target_id,
                stale_title: link.stale_title,
                parent: parent.map(str::to_string),
                depth,
            });
        }
        Ok(())
    })
}

fn read_link(node: &LoroMap) -> Result<Option<LinkRefDto>> {
    if get_string(node, KEY_NODE_NAME)?.as_deref() != Some(LINK_NODE_NAME) {
        return Ok(None);
    }
    let attrs = get_map(node, KEY_ATTRIBUTES)?;
    let id = attrs.as_ref().and_then(|a| get_string(a, ATTR_ID).ok().flatten()).unwrap_or_default();
    let target_id = attrs.as_ref().and_then(|a| get_string(a, ATTR_TARGET_ID).ok().flatten());
    let stale_title = attrs.as_ref().and_then(|a| get_string(a, ATTR_STALE_TITLE).ok().flatten());
    Ok(Some(LinkRefDto { id, target_id, stale_title }))
}

/// Rewrites every `linkRef` whose `targetId` points at a heading that
/// existed in `before` but no longer exists in the document now, to the
/// nearest ancestor (per `before`'s parent chain) that *does* still exist —
/// skipping any ancestor that was *also* deleted in the same change (e.g.
/// deleting a whole subtree at once reparents grandchildren straight to
/// the subtree's old parent, not to an intermediate node that's equally
/// gone). A link whose entire ancestor chain was deleted has nothing left
/// to reparent onto: its `targetId` is cleared and its last known title is
/// stamped onto `staleTitle` so the UI can show something instead of
/// nothing.
///
/// Called from `DendroidDocument::import_foreign_update`/`poll_external` —
/// see that module's doc comment for why this lives outside the "no
/// structural mutation API" rule the rest of the document model follows:
/// this is derived-consistency upkeep (closer to a database trigger),
/// never something a caller invokes directly to restructure the document.
///
/// Returns whether anything changed, so the caller knows whether a further
/// export/ledger-append is warranted.
pub(crate) fn reconcile_backlinks(doc: &LoroDoc, before: &[HeadingDto]) -> Result<bool> {
    let after = crate::outline::outline(doc)?;
    let after_ids: std::collections::HashSet<&str> = after.iter().map(|h| h.id.as_str()).collect();

    let removed: Vec<&HeadingDto> = before.iter().filter(|h| !after_ids.contains(h.id.as_str())).collect();
    if removed.is_empty() {
        return Ok(false);
    }

    let before_parent: HashMap<&str, Option<&str>> = before.iter().map(|h| (h.id.as_str(), h.parent.as_deref())).collect();
    let before_title: HashMap<&str, &str> = before.iter().map(|h| (h.id.as_str(), h.title.as_str())).collect();

    // Resolve each removed id to the nearest still-surviving ancestor.
    let mut replacement: HashMap<String, Option<String>> = HashMap::new();
    for h in &removed {
        let mut cursor = before_parent.get(h.id.as_str()).copied().flatten();
        while let Some(id) = cursor {
            if after_ids.contains(id) {
                break;
            }
            cursor = before_parent.get(id).copied().flatten();
        }
        replacement.insert(h.id.clone(), cursor.map(str::to_string));
    }

    let mut changed = false;
    walk_nodes(&root(doc), &mut |node| {
        if get_string(node, KEY_NODE_NAME)?.as_deref() != Some(LINK_NODE_NAME) {
            return Ok(());
        }
        let Some(attrs) = get_map(node, KEY_ATTRIBUTES)? else { return Ok(()) };
        let Some(target_id) = get_string(&attrs, ATTR_TARGET_ID)? else { return Ok(()) };
        let Some(resolved) = replacement.get(target_id.as_str()) else { return Ok(()) };

        match resolved {
            Some(new_target) => attrs.insert(ATTR_TARGET_ID, new_target.as_str())?,
            None => {
                attrs.delete(ATTR_TARGET_ID)?;
                if let Some(title) = before_title.get(target_id.as_str()) {
                    attrs.insert(ATTR_STALE_TITLE, *title)?;
                }
            }
        }
        changed = true;
        Ok(())
    })?;

    if changed {
        doc.commit();
    }
    Ok(changed)
}
