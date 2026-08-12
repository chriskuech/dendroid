//! Derives a heading outline from the document — read-only, computed on
//! demand. There is no *separate* structural CRDT for the tree: the
//! whitepaper's own model is "one giant markdown graph" where "a child
//! heading is an implicit link to its parent" — nesting lives in the same
//! document TipTap edits directly via `loro-prosemirror`'s
//! `LoroSyncPlugin({ doc })` (its *default* binding: no `containerId`,
//! meaning the container Loro creates at the root named `"doc"`), just
//! genuinely *structural* now rather than inferred by comparing heading
//! levels across a flat list.
//!
//! Concretely (see loro-prosemirror's `src/lib.ts`, which is the actual
//! contract this module depends on): every PM node is a `LoroMap` with a
//! plain `"nodeName"` field, an `"attributes"` sub-map (the PM node's
//! `attrs`), and a `"children"` sub-list holding either nested node maps
//! or `LoroText` runs (consecutive PM text nodes are merged into one
//! `LoroText`, which is also where marks live, as per-span delta
//! attributes). A heading and everything nested under it — its body
//! content, and any subheadings — are wrapped together in one `section`
//! node: `section.children == [heading, ...body]`, where a `section`
//! inside that body is a nested subheading. `section` (not `heading`) is
//! what carries the stable `id` `@`-links and the tree view address a
//! heading by — a `section`'s own container *is* that heading's whole
//! subtree, addressable and (eventually) independently bindable, which is
//! the whole point of the shape (see the `@`-links plan). `heading` itself
//! is just the title: inline content plus a `level` attribute for
//! markdown/typography, no identity of its own.
//!
//! Because structure is derived rather than separately stored, there is no
//! create/rename/move/delete-node API here: changing a heading's text or
//! title is just editing the document like any other text. *Where* a
//! section nests, though, is real tree position now, not something a
//! reader infers — see `dendroid_core::migrate` for how a workspace's
//! pre-existing (flat) documents get folded into this shape once, and the
//! `@`-links plan's "Explicit follow-up" for the editor-side extension that
//! keeps a typed heading level (`#`/`##`/`###`) and its actual nesting in
//! sync automatically as you type, so authoring doesn't change.
//!
//! `@`-links (`linkRef`, see `crate::links`) are addressed the same way —
//! by a heading's (i.e. its `section`'s) stable `id` — but unlike sections
//! they're inline content, so they can live nested anywhere inside a
//! section's body rather than only ever being a section's own wrapper;
//! `outline_with_links` below is the one place that walks both together.

use loro::{LoroDoc, LoroList, LoroMap};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::links::{self, LinkEntryDto};
use crate::loro_walk::{
    get_i64, get_list, get_map, get_string, ATTR_ID, DOC_ROOT, KEY_ATTRIBUTES, KEY_CHILDREN, KEY_NODE_NAME, SECTION_NODE_NAME,
};

const HEADING_NODE_NAME: &str = "heading";
const ATTR_LEVEL: &str = "level";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingDto {
    pub id: String,
    pub parent: Option<String>,
    pub index: usize,
    /// Structural nesting depth — now literally the section's recursion
    /// depth in the tree, not derived by comparing levels. Still not the
    /// same number as `level` (a level-3 heading directly under a level-1
    /// heading has `depth` 1, `level` 3): `level` stays purely
    /// author-controlled typography/markdown-export info.
    pub depth: u32,
    pub level: u8,
    pub title: String,
}

/// Walks the document and returns its headings in depth-first order, each
/// preceded by its ancestors — the same shape `markdown::render_outline`
/// and the frontend's tree view expect.
pub fn outline(doc: &LoroDoc) -> Result<Vec<HeadingDto>> {
    let root = doc.get_map(DOC_ROOT);
    let Some(children) = get_list(&root, KEY_CHILDREN)? else {
        // Nothing has synced an editor's content into this doc yet.
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    walk_sections(&children, None, 0, &mut out)?;
    Ok(out)
}

/// Recurses through `children` (a `doc`'s or a `section`'s own children
/// list), appending a `HeadingDto` for every `section` found — a section's
/// own body (past its leading `heading`) is walked in the same pass, one
/// depth deeper, for any further nested sections. `index` is naturally
/// scoped per call (i.e. per parent), since each recursive call only ever
/// sees one parent's direct children.
fn walk_sections(children: &LoroList, parent: Option<&str>, depth: u32, out: &mut Vec<HeadingDto>) -> Result<()> {
    let mut index = 0usize;
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue }; // a LoroText run: shouldn't appear at this level, but skip rather than panic
        let Ok(node) = container.into_map() else { continue };
        if get_string(&node, KEY_NODE_NAME)?.as_deref() != Some(SECTION_NODE_NAME) {
            continue;
        }
        let Some(section_children) = get_list(&node, KEY_CHILDREN)? else { continue };
        let Some(heading) = leading_heading(&section_children)? else { continue };

        let attrs = get_map(&node, KEY_ATTRIBUTES)?;
        // Falls back to a position-based id for sections the extension
        // hasn't stamped yet (or content synced from a plain, non-TipTap
        // writer) — stable only until the doc reflows, but keeps the
        // outline usable rather than panicking on a missing attribute.
        let id = attrs.as_ref().and_then(|a| get_string(a, ATTR_ID).ok().flatten()).unwrap_or_else(|| format!("pos:{i}"));
        let heading_attrs = get_map(&heading, KEY_ATTRIBUTES)?;
        let level = heading_attrs.as_ref().and_then(|a| get_i64(a, ATTR_LEVEL).ok().flatten()).unwrap_or(1).clamp(1, 255) as u8;
        let title = heading_title(&heading)?;

        out.push(HeadingDto { id: id.clone(), parent: parent.map(str::to_string), index, depth, level, title });
        index += 1;

        walk_sections(&section_children, Some(&id), depth + 1, out)?;
    }
    Ok(())
}

/// One row of the combined heading+link outline `outline_with_links`
/// produces — a tagged union rather than two separate lists so the tree
/// view can render both in one interleaved, document-order pass without
/// re-deriving where each link falls relative to the headings around it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutlineEntry {
    Heading(HeadingDto),
    Link(LinkEntryDto),
}

/// Same walk as `outline`, but also finds every `linkRef` nested in each
/// section's own body content (a paragraph, a list, ...) and files it
/// right after the section that currently encloses it, one depth level
/// deeper — the shape `TreeView` needs to nest an `@`-link (and, if
/// expanded, its target's subtree) under the section it appears in,
/// mirroring how a nested heading already nests under its parent there.
/// The headings-only `outline` stays the cheaper, more common case (it's
/// what every other caller — backlink reconciliation, `markdown::
/// render_outline`, MCP's `getOutline` — actually needs).
pub fn outline_with_links(doc: &LoroDoc) -> Result<Vec<OutlineEntry>> {
    let root = doc.get_map(DOC_ROOT);
    let Some(children) = get_list(&root, KEY_CHILDREN)? else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    walk_sections_with_links(&children, None, 0, &mut out)?;
    Ok(out)
}

fn walk_sections_with_links(children: &LoroList, parent: Option<&str>, depth: u32, out: &mut Vec<OutlineEntry>) -> Result<()> {
    let mut index = 0usize;
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(node) = container.into_map() else { continue };
        if get_string(&node, KEY_NODE_NAME)?.as_deref() != Some(SECTION_NODE_NAME) {
            continue;
        }
        let Some(section_children) = get_list(&node, KEY_CHILDREN)? else { continue };
        let Some(heading) = leading_heading(&section_children)? else { continue };

        let attrs = get_map(&node, KEY_ATTRIBUTES)?;
        let id = attrs.as_ref().and_then(|a| get_string(a, ATTR_ID).ok().flatten()).unwrap_or_else(|| format!("pos:{i}"));
        let heading_attrs = get_map(&heading, KEY_ATTRIBUTES)?;
        let level = heading_attrs.as_ref().and_then(|a| get_i64(a, ATTR_LEVEL).ok().flatten()).unwrap_or(1).clamp(1, 255) as u8;
        let title = heading_title(&heading)?;

        out.push(OutlineEntry::Heading(HeadingDto { id: id.clone(), parent: parent.map(str::to_string), index, depth, level, title }));
        index += 1;

        // Body content, one level deeper: any `@`-link nested inside a
        // body block (not itself a nested `section` — that's a child
        // heading, walked by the recursive call below) files under this
        // section's own id.
        for j in 1..section_children.len() {
            let Some(bentry) = section_children.get(j) else { continue };
            let Ok(bcontainer) = bentry.into_container() else { continue };
            let Ok(bnode) = bcontainer.into_map() else { continue };
            if get_string(&bnode, KEY_NODE_NAME)?.as_deref() == Some(SECTION_NODE_NAME) {
                continue;
            }
            let mut links_here = Vec::new();
            links::collect_link_entries(&bnode, Some(id.as_str()), depth + 1, &mut links_here)?;
            out.extend(links_here.into_iter().map(OutlineEntry::Link));
        }

        walk_sections_with_links(&section_children, Some(&id), depth + 1, out)?;
    }
    Ok(())
}

/// A section's own leading `heading` child (its title), if its `children`
/// actually starts with one — sections are always built this way, but a
/// malformed/foreign write shouldn't panic, just be skipped by callers.
fn leading_heading(section_children: &LoroList) -> Result<Option<LoroMap>> {
    let Some(entry) = section_children.get(0) else { return Ok(None) };
    let Ok(container) = entry.into_container() else { return Ok(None) };
    let Ok(node) = container.into_map() else { return Ok(None) };
    if get_string(&node, KEY_NODE_NAME)?.as_deref() == Some(HEADING_NODE_NAME) {
        Ok(Some(node))
    } else {
        Ok(None)
    }
}

/// Concatenates a heading node's own inline text content (its title).
/// Headings only contain inline content in practice, so this doesn't need
/// to recurse into nested block nodes.
fn heading_title(node: &LoroMap) -> Result<String> {
    let Some(children) = get_list(node, KEY_CHILDREN)? else {
        return Ok(String::new());
    };
    let mut title = String::new();
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        if let Ok(text) = container.into_text() {
            title.push_str(&text.to_string());
        }
    }
    Ok(title)
}
