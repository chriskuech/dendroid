//! Body-content markdown — the read/write halves the MCP server's
//! `getTree`/`insert`/`replaceContent` need (and, per the `@`-links plan,
//! the one abstraction meant to be shared with a future lazily-loaded
//! editor slice, even though this pass doesn't wire the editor onto it —
//! see `resolve_slice`'s doc comment).
//!
//! Covers the actual active TipTap node/mark set (`StarterKit` defaults
//! minus its own `heading`, plus `HeadingWithId` and `linkRef` — see
//! `Editor.tsx`'s config): paragraph, heading (nested inside its
//! `section` wrapper — see `crate::outline`'s doc comment), marks
//! (bold/italic/strike/code), codeBlock, blockquote, bulletList/
//! orderedList (flat — a list item's own nested sub-lists are a
//! documented gap, not attempted here), horizontalRule, and `linkRef`
//! (round-tripped as `@{heading-id}`, a syntax this module owns rather
//! than anything CommonMark defines).
//!
//! Marks are stored as per-span delta attributes on a `LoroText`, keyed by
//! the ProseMirror mark's own type name — see `loro-prosemirror`'s
//! `nodeMarksToAttributes`/`createNodeFromLoroObj`, the actual contract
//! this depends on (mirrors the encoding `outline.rs`'s doc comment
//! describes for node maps).

use std::collections::HashSet;

use loro::{LoroDoc, LoroList, LoroMap, LoroText};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::error::Result;
use crate::links::{ATTR_STALE_TITLE, ATTR_TARGET_ID, LINK_NODE_NAME};
use crate::loro_walk::{
    get_i64, get_list, get_map, get_string, root, ATTR_ID, KEY_ATTRIBUTES, KEY_CHILDREN, KEY_NODE_NAME, SECTION_NODE_NAME,
};
use crate::outline::{self, HeadingDto};

const HEADING_NODE_NAME: &str = "heading";
const PARAGRAPH: &str = "paragraph";
const CODE_BLOCK: &str = "codeBlock";
const BLOCKQUOTE: &str = "blockquote";
const BULLET_LIST: &str = "bulletList";
const ORDERED_LIST: &str = "orderedList";
const LIST_ITEM: &str = "listItem";
const HORIZONTAL_RULE: &str = "horizontalRule";
const MARK_NAMES: [&str; 4] = ["bold", "italic", "strike", "code"];

/// Renders `headings` (as returned by `DendroidDocument::outline`) as a
/// markdown heading outline, e.g.:
///
/// ```text
/// # Project Ideas
/// ## Dendroid
/// ```
///
/// `headings` must be in depth-first order with each heading preceded by
/// its ancestors, which is exactly what `outline::outline` produces.
pub fn render_outline(headings: &[HeadingDto]) -> String {
    let mut out = String::new();
    for heading in headings {
        out.push_str(&"#".repeat(heading.level.max(1) as usize));
        out.push(' ');
        out.push_str(&heading.title);
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------- read --

/// Markdown for a slice of the document: `root_id`'s subtree (or the whole
/// document if `None`) out to `depth` heading levels, optionally inlining
/// each `@`-link's own target subtree (to `link_depth`) instead of leaving
/// it as a bare reference. This is what MCP's `getTree` wraps directly.
///
/// It's also the one primitive meant to be shared with the editor's own
/// rendering — the `@`-links plan's premise that "the editor shouldn't
/// load the whole document, it should resolve slices with links expanded
/// to depth N, and the MCP server should expose that same abstraction."
/// This pass doesn't switch the editor onto it (see that plan's "Explicit
/// follow-up" section), but the primitive itself is real, not just
/// MCP-shaped, so that migration has something to plug into.
pub fn resolve_slice(doc: &LoroDoc, root_id: Option<&str>, depth: u32, expand_links: bool, link_depth: u32) -> Result<String> {
    let outline = outline::outline(doc)?;
    let scope = scope_ids(&outline, root_id, depth);
    let mut visiting = HashSet::new();
    if let Some(id) = root_id {
        visiting.insert(id.to_string());
    }
    render_scope(doc, root_id, &outline, &scope, expand_links, link_depth, &mut visiting)
}

/// Heading ids visible in a slice rooted at `root_id` (or the whole
/// outline if `None`) out to `depth` levels — same subtree-with-depth-cap
/// shape as the frontend's `subtreeRows` (`lib/crdt/outline.ts`), just
/// computed here so `getTree` doesn't need a live JS mirror to ask. Purely
/// a filter over `HeadingDto`'s `depth` field, so this is unaffected by
/// how the document is actually stored.
fn scope_ids(outline: &[HeadingDto], root_id: Option<&str>, depth: u32) -> HashSet<String> {
    match root_id {
        None => outline.iter().filter(|h| h.depth < depth).map(|h| h.id.clone()).collect(),
        Some(root) => {
            let Some(start) = outline.iter().position(|h| h.id == root) else { return HashSet::new() };
            let root_depth = outline[start].depth;
            let mut ids: HashSet<String> = [outline[start].id.clone()].into();
            for h in &outline[start + 1..] {
                if h.depth <= root_depth {
                    break;
                }
                if h.depth - root_depth <= depth {
                    ids.insert(h.id.clone());
                }
            }
            ids
        }
    }
}

/// Renders whatever's in `scope`, starting from `root_id`'s own section
/// (or, if `None`, every top-level section) — `root_id` and `scope` always
/// agree by construction (`scope_ids` always seeds `scope` with `root_id`
/// itself when it's `Some`), so the section this starts at is always in
/// scope; the only thing `scope` filters is how much of it (and how far
/// down) actually gets rendered.
fn render_scope(
    doc: &LoroDoc,
    root_id: Option<&str>,
    outline: &[HeadingDto],
    scope: &HashSet<String>,
    expand_links: bool,
    link_depth: u32,
    visiting: &mut HashSet<String>,
) -> Result<String> {
    let doc_root = root(doc);
    let Some(children) = get_list(&doc_root, KEY_CHILDREN)? else { return Ok(String::new()) };

    let mut out = String::new();
    match root_id {
        None => render_sections(&children, doc, outline, scope, expand_links, link_depth, visiting, &mut out)?,
        Some(id) => {
            if let Some(section) = find_section(&children, id)? {
                render_section(&section, doc, outline, scope, expand_links, link_depth, visiting, &mut out)?;
            }
        }
    }
    Ok(out)
}

/// Renders every `section` in `children` that's in `scope` — used at the
/// document's own top level. A section not in scope is skipped entirely,
/// including everything nested under it: `scope`'s depth cap is monotonic
/// (a child's depth is always its parent's plus one, `outline::
/// walk_sections`), so nothing nested inside an out-of-scope section could
/// itself be in scope.
fn render_sections(
    children: &LoroList,
    doc: &LoroDoc,
    outline: &[HeadingDto],
    scope: &HashSet<String>,
    expand_links: bool,
    link_depth: u32,
    visiting: &mut HashSet<String>,
    out: &mut String,
) -> Result<()> {
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(node) = container.into_map() else { continue };
        if get_string(&node, KEY_NODE_NAME)?.as_deref() != Some(SECTION_NODE_NAME) {
            continue;
        }
        render_section(&node, doc, outline, scope, expand_links, link_depth, visiting, out)?;
    }
    Ok(())
}

/// Renders one `section` node (its heading line, then its body — recursing
/// into any nested `section`s the same way) if its own id is in `scope`.
fn render_section(
    node: &LoroMap,
    doc: &LoroDoc,
    outline: &[HeadingDto],
    scope: &HashSet<String>,
    expand_links: bool,
    link_depth: u32,
    visiting: &mut HashSet<String>,
    out: &mut String,
) -> Result<()> {
    let Some(section_children) = get_list(node, KEY_CHILDREN)? else { return Ok(()) };
    let Some(heading) = leading_heading(&section_children)? else { return Ok(()) };
    let attrs = get_map(node, KEY_ATTRIBUTES)?;
    let id = attrs.as_ref().and_then(|a| get_string(a, ATTR_ID).ok().flatten()).unwrap_or_default();

    if !scope.contains(&id) {
        return Ok(());
    }

    let heading_attrs = get_map(&heading, KEY_ATTRIBUTES)?;
    let level = heading_attrs.as_ref().and_then(|a| get_i64(a, "level").ok().flatten()).unwrap_or(1).clamp(1, 255) as u8;

    out.push_str(&"#".repeat(level as usize));
    out.push(' ');
    render_inline(&heading, doc, outline, expand_links, link_depth, visiting, out)?;
    out.push_str("\n\n");

    for j in 1..section_children.len() {
        let Some(entry) = section_children.get(j) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(child) = container.into_map() else { continue };
        let Some(name) = get_string(&child, KEY_NODE_NAME)? else { continue };
        if name == SECTION_NODE_NAME {
            render_section(&child, doc, outline, scope, expand_links, link_depth, visiting, out)?;
        } else {
            render_block(&child, &name, "", doc, outline, expand_links, link_depth, visiting, out)?;
        }
    }

    Ok(())
}

fn render_block(
    node: &LoroMap,
    name: &str,
    indent: &str,
    doc: &LoroDoc,
    outline: &[HeadingDto],
    expand_links: bool,
    link_depth: u32,
    visiting: &mut HashSet<String>,
    out: &mut String,
) -> Result<()> {
    match name {
        PARAGRAPH => {
            out.push_str(indent);
            render_inline(node, doc, outline, expand_links, link_depth, visiting, out)?;
            out.push_str("\n\n");
        }
        CODE_BLOCK => {
            let lang = get_map(node, KEY_ATTRIBUTES)?.and_then(|a| get_string(&a, "language").ok().flatten()).unwrap_or_default();
            out.push_str(indent);
            out.push_str("```");
            out.push_str(&lang);
            out.push('\n');
            out.push_str(indent);
            out.push_str(&plain_text(node)?);
            out.push('\n');
            out.push_str(indent);
            out.push_str("```\n\n");
        }
        BLOCKQUOTE => {
            let Some(children) = get_list(node, KEY_CHILDREN)? else { return Ok(()) };
            let child_indent = format!("{indent}> ");
            for i in 0..children.len() {
                let Some(entry) = children.get(i) else { continue };
                let Ok(container) = entry.into_container() else { continue };
                let Ok(child) = container.into_map() else { continue };
                let Some(child_name) = get_string(&child, KEY_NODE_NAME)? else { continue };
                render_block(&child, &child_name, &child_indent, doc, outline, expand_links, link_depth, visiting, out)?;
            }
        }
        BULLET_LIST | ORDERED_LIST => {
            let ordered = name == ORDERED_LIST;
            let Some(items) = get_list(node, KEY_CHILDREN)? else { return Ok(()) };
            for i in 0..items.len() {
                let Some(entry) = items.get(i) else { continue };
                let Ok(container) = entry.into_container() else { continue };
                let Ok(item) = container.into_map() else { continue };
                let marker = if ordered { format!("{}. ", i + 1) } else { "- ".to_string() };
                out.push_str(indent);
                out.push_str(&marker);
                render_list_item_inline(&item, doc, outline, expand_links, link_depth, visiting, out)?;
                out.push('\n');
            }
            out.push('\n');
        }
        HORIZONTAL_RULE => {
            out.push_str(indent);
            out.push_str("---\n\n");
        }
        _ => {} // unrecognized node type (including a stray `section`/`heading` — shouldn't occur here): not part of the covered subset, skip rather than fail the whole render
    }
    Ok(())
}

/// A list item's own inline content, flattened onto the marker's line —
/// nested sub-lists inside a list item are a documented gap this module's
/// header comment calls out, not attempted here.
fn render_list_item_inline(
    item: &LoroMap,
    doc: &LoroDoc,
    outline: &[HeadingDto],
    expand_links: bool,
    link_depth: u32,
    visiting: &mut HashSet<String>,
    out: &mut String,
) -> Result<()> {
    let Some(children) = get_list(item, KEY_CHILDREN)? else { return Ok(()) };
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(child) = container.into_map() else { continue };
        if get_string(&child, KEY_NODE_NAME)?.as_deref() == Some(PARAGRAPH) {
            render_inline(&child, doc, outline, expand_links, link_depth, visiting, out)?;
        }
    }
    Ok(())
}

/// Renders a node's own inline content (its `children` list of text runs
/// and `linkRef` atoms) as markdown — marks become the usual
/// `**bold**`/`_italic_`/`~~strike~~`/`` `code` `` wrapping, applied
/// per-span from the `LoroText`'s delta attributes.
fn render_inline(
    node: &LoroMap,
    doc: &LoroDoc,
    outline: &[HeadingDto],
    expand_links: bool,
    link_depth: u32,
    visiting: &mut HashSet<String>,
    out: &mut String,
) -> Result<()> {
    let Some(children) = get_list(node, KEY_CHILDREN)? else { return Ok(()) };
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };

        if let Ok(text) = container.clone().into_text() {
            render_text_delta(&text, out);
            continue;
        }

        let Ok(child) = container.into_map() else { continue };
        if get_string(&child, KEY_NODE_NAME)?.as_deref() != Some(LINK_NODE_NAME) {
            continue;
        }
        let attrs = get_map(&child, KEY_ATTRIBUTES)?;
        let target_id = attrs.as_ref().and_then(|a| get_string(a, ATTR_TARGET_ID).ok().flatten());
        let stale_title = attrs.as_ref().and_then(|a| get_string(a, ATTR_STALE_TITLE).ok().flatten());

        let Some(target_id) = target_id else {
            out.push_str(&format!("@{{deleted:{}}}", stale_title.unwrap_or_default()));
            continue;
        };

        if !expand_links || link_depth == 0 || visiting.contains(&target_id) {
            out.push_str(&format!("@{{{target_id}}}"));
            continue;
        }

        visiting.insert(target_id.clone());
        let nested_scope = scope_ids(outline, Some(&target_id), link_depth);
        let nested = render_scope(doc, Some(target_id.as_str()), outline, &nested_scope, expand_links, link_depth, visiting)?;
        visiting.remove(&target_id);
        out.push('\n');
        out.push_str(nested.trim_end());
        out.push('\n');
    }
    Ok(())
}

fn render_text_delta(text: &LoroText, out: &mut String) {
    for delta in text.to_delta() {
        let loro::TextDelta::Insert { insert, attributes } = delta else { continue };
        let marks: Vec<&str> = attributes
            .as_ref()
            .map(|a| MARK_NAMES.iter().copied().filter(|m| a.contains_key(*m)).collect())
            .unwrap_or_default();

        let (open, close) = wrap_for_marks(&marks);
        out.push_str(&open);
        out.push_str(&insert);
        out.push_str(&close);
    }
}

/// Innermost-first opening / innermost-first-reversed closing wrap for a
/// span's marks — order doesn't change CommonMark's meaning here (bold/
/// italic/strike/code all nest unambiguously), so a fixed, stable order
/// (matching `MARK_NAMES`) is enough to keep round-trips byte-stable.
fn wrap_for_marks(marks: &[&str]) -> (String, String) {
    let mut open = String::new();
    let mut close = String::new();
    for mark in marks {
        let (o, c) = match *mark {
            "bold" => ("**", "**"),
            "italic" => ("_", "_"),
            "strike" => ("~~", "~~"),
            "code" => ("`", "`"),
            _ => continue,
        };
        open.push_str(o);
        close.insert_str(0, c);
    }
    (open, close)
}

/// A code block's own plain text content — code blocks don't carry marks.
fn plain_text(node: &LoroMap) -> Result<String> {
    let Some(children) = get_list(node, KEY_CHILDREN)? else { return Ok(String::new()) };
    let mut text = String::new();
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        if let Ok(t) = container.into_text() {
            text.push_str(&t.to_string());
        }
    }
    Ok(text)
}

/// A section's own leading `heading` child — same helper as
/// `outline::leading_heading`, duplicated locally since it's `crate`-
/// private there and this module needs the exact same "skip, don't panic,
/// on a malformed section" behavior.
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

/// Finds the `section` whose own `id` attribute is `target_id`, searching
/// `children` (a `doc`'s or a `section`'s own children list) and every
/// nested `section` inside it, depth-first.
fn find_section(children: &LoroList, target_id: &str) -> Result<Option<LoroMap>> {
    for i in 0..children.len() {
        let Some(entry) = children.get(i) else { continue };
        let Ok(container) = entry.into_container() else { continue };
        let Ok(node) = container.into_map() else { continue };
        if get_string(&node, KEY_NODE_NAME)?.as_deref() != Some(SECTION_NODE_NAME) {
            continue;
        }
        let Some(section_children) = get_list(&node, KEY_CHILDREN)? else { continue };
        let attrs = get_map(&node, KEY_ATTRIBUTES)?;
        let id = attrs.as_ref().and_then(|a| get_string(a, ATTR_ID).ok().flatten());
        if id.as_deref() == Some(target_id) {
            return Ok(Some(node));
        }
        if let Some(found) = find_section(&section_children, target_id)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

// --------------------------------------------------------------- write --

/// Where `apply_markdown`'s parsed nodes land relative to `target_id`'s
/// section.
pub enum ApplyMode {
    /// Appended as new content at the end of `target_id`'s section body
    /// (right before... nothing — a section's body has no notion of
    /// "before the next heading" anymore, it *is* everything up to its
    /// own end) — "add this content inside the section."
    Insert,
    /// Replaces everything currently inside `target_id`'s section body
    /// (all body content *and* nested subheadings) with the parsed
    /// content — `target_id`'s own heading line (title, level, id) is
    /// untouched. "Content" here means what's under the heading, not the
    /// heading itself.
    Replace,
}

/// Parses `content` (the same node/mark subset `resolve_slice` renders —
/// paragraph, heading, marks, codeBlock, blockquote, flat bullet/ordered
/// lists, horizontal rules, and `@{heading-id}` links) and splices the
/// result into the document at `target_id` per `mode`. Used by MCP's
/// `insert`/`replaceContent`.
pub fn apply_markdown(doc: &LoroDoc, target_id: &str, content: &str, mode: ApplyMode) -> Result<()> {
    let doc_root = root(doc);
    let children = doc_root.ensure_mergeable_list(KEY_CHILDREN)?;
    let events: Vec<Event> = Parser::new_ext(content, Options::empty()).collect();

    match find_section(&children, target_id)? {
        Some(section) => {
            let section_children = section.ensure_mergeable_list(KEY_CHILDREN)?;
            // Index 0 is the section's own heading — the body starts at 1.
            let body_len = section_children.len().saturating_sub(1);
            let write_at = match mode {
                ApplyMode::Insert => section_children.len(),
                ApplyMode::Replace => {
                    if body_len > 0 {
                        section_children.delete(1, body_len)?;
                    }
                    1
                }
            };
            write_sections(&section_children, write_at, &events)?;
        }
        // Unknown id: append at the document's end rather than failing —
        // matches the old behavior of appending rather than erroring.
        None => {
            write_sections(&children, children.len(), &events)?;
        }
    }

    doc.commit();
    Ok(())
}

/// Writes one non-heading block-level item (`Paragraph`/`CodeBlock`/
/// `BlockQuote`/`BulletList`/`OrderedList`/`Rule`) starting at
/// `events[i]` into `children` at `pos`. Returns the index just past the
/// block consumed, or `None` if `events[i]` isn't one of these (a heading,
/// or structural noise) — callers handle both of those themselves, since
/// what a heading becomes differs between `write_blocks` (flat, used for
/// blockquote/list-item bodies — nested sections aren't supported there,
/// the same documented gap as nested sub-lists) and `write_sections` (used
/// at the document's top level and inside a section's own body, where a
/// heading opens a new nested `section`).
fn write_block_event(children: &LoroList, pos: usize, events: &[Event]) -> Result<Option<usize>> {
    let i = 0;
    match &events[i] {
        Event::Start(Tag::Paragraph) => {
            let end = find_end(events, i);
            let node = children.insert_container(pos, LoroMap::new())?;
            node.insert(KEY_NODE_NAME, PARAGRAPH)?;
            let node_children = node.ensure_mergeable_list(KEY_CHILDREN)?;
            write_inline(&node_children, &events[i + 1..end])?;
            Ok(Some(end + 1))
        }
        Event::Start(Tag::CodeBlock(kind)) => {
            let end = find_end(events, i);
            let node = children.insert_container(pos, LoroMap::new())?;
            node.insert(KEY_NODE_NAME, CODE_BLOCK)?;
            let attrs = node.ensure_mergeable_map(KEY_ATTRIBUTES)?;
            if let CodeBlockKind::Fenced(lang) = kind {
                attrs.insert("language", lang.to_string().as_str())?;
            }
            let node_children = node.ensure_mergeable_list(KEY_CHILDREN)?;
            let mut code = String::new();
            for event in &events[i + 1..end] {
                if let Event::Text(t) = event {
                    code.push_str(t);
                }
            }
            let text = node_children.insert_container(0, LoroText::new())?;
            text.insert(0, code.trim_end_matches('\n'))?;
            Ok(Some(end + 1))
        }
        Event::Start(Tag::BlockQuote(_)) => {
            let end = find_end(events, i);
            let node = children.insert_container(pos, LoroMap::new())?;
            node.insert(KEY_NODE_NAME, BLOCKQUOTE)?;
            let node_children = node.ensure_mergeable_list(KEY_CHILDREN)?;
            write_blocks(&node_children, 0, &events[i + 1..end])?;
            Ok(Some(end + 1))
        }
        Event::Start(Tag::List(ordered)) => {
            let end = find_end(events, i);
            let node = children.insert_container(pos, LoroMap::new())?;
            node.insert(KEY_NODE_NAME, if ordered.is_some() { ORDERED_LIST } else { BULLET_LIST })?;
            let items = node.ensure_mergeable_list(KEY_CHILDREN)?;
            write_list_items(&items, &events[i + 1..end])?;
            Ok(Some(end + 1))
        }
        Event::Rule => {
            let node = children.insert_container(pos, LoroMap::new())?;
            node.insert(KEY_NODE_NAME, HORIZONTAL_RULE)?;
            Ok(Some(i + 1))
        }
        _ => Ok(None),
    }
}

/// Flat block writer: every event becomes a sibling at the same level,
/// headings included (as a bare, id-less `heading` node — outline reads
/// never look inside a blockquote/list item, so this can't become part of
/// the addressable outline; kept only so round-tripping content that
/// happens to contain one doesn't crash). Used for blockquote and list
/// item bodies, where nested sections aren't supported (same documented
/// gap as nested sub-lists).
fn write_blocks(children: &LoroList, at: usize, events: &[Event]) -> Result<usize> {
    let mut pos = at;
    let mut i = 0;
    while i < events.len() {
        if let Some(next_i) = write_block_event(children, pos, &events[i..])? {
            pos += 1;
            i += next_i;
            continue;
        }
        match &events[i] {
            Event::Start(Tag::Heading { level, .. }) => {
                let end = find_end(events, i);
                let node = children.insert_container(pos, LoroMap::new())?;
                node.insert(KEY_NODE_NAME, HEADING_NODE_NAME)?;
                let attrs = node.ensure_mergeable_map(KEY_ATTRIBUTES)?;
                attrs.insert("level", heading_level_number(*level))?;
                let node_children = node.ensure_mergeable_list(KEY_CHILDREN)?;
                write_inline(&node_children, &events[i + 1..end])?;
                pos += 1;
                i = end + 1;
            }
            _ => i += 1, // blank text/other structural noise between blocks
        }
    }
    Ok(pos - at)
}

/// Section-aware block writer: a heading opens a fresh `section` wrapping
/// itself and everything up to (not including) the next heading at or
/// above its own level — the write-time counterpart to `find_section`
/// locating an existing one on read. Used at the document's top level and
/// inside a section's own body (recursively, for nested subheadings).
///
/// Note: like the old (pre-nesting) `subtree_range`, the "next heading at
/// or above this level" scan below is a flat scan across *all* remaining
/// events, so a heading typed inside an intervening blockquote/list (valid
/// CommonMark, e.g. `> # Heading`) would be mistaken for this section's
/// boundary — the same documented, pre-existing gap as nested sub-lists
/// (headings inside a blockquote/list item already can't round-trip via
/// `write_blocks`/`render_block` either).
fn write_sections(children: &LoroList, at: usize, events: &[Event]) -> Result<usize> {
    let mut pos = at;
    let mut i = 0;
    while i < events.len() {
        if let Some(next_i) = write_block_event(children, pos, &events[i..])? {
            pos += 1;
            i += next_i;
            continue;
        }
        match &events[i] {
            Event::Start(Tag::Heading { level, .. }) => {
                let heading_end = find_end(events, i);
                let level_n = heading_level_number(*level) as u8;

                let mut body_end = events.len();
                for (j, event) in events.iter().enumerate().skip(heading_end + 1) {
                    if let Event::Start(Tag::Heading { level: l, .. }) = event {
                        if heading_level_number(*l) as u8 <= level_n {
                            body_end = j;
                            break;
                        }
                    }
                }

                let section = children.insert_container(pos, LoroMap::new())?;
                section.insert(KEY_NODE_NAME, SECTION_NODE_NAME)?;
                let section_attrs = section.ensure_mergeable_map(KEY_ATTRIBUTES)?;
                section_attrs.insert(ATTR_ID, uuid::Uuid::new_v4().to_string().as_str())?;
                let section_children = section.ensure_mergeable_list(KEY_CHILDREN)?;

                let heading_node = section_children.insert_container(0, LoroMap::new())?;
                heading_node.insert(KEY_NODE_NAME, HEADING_NODE_NAME)?;
                let heading_attrs = heading_node.ensure_mergeable_map(KEY_ATTRIBUTES)?;
                heading_attrs.insert("level", level_n as i64)?;
                let heading_children = heading_node.ensure_mergeable_list(KEY_CHILDREN)?;
                write_inline(&heading_children, &events[i + 1..heading_end])?;

                write_sections(&section_children, 1, &events[heading_end + 1..body_end])?;

                pos += 1;
                i = body_end;
            }
            _ => i += 1,
        }
    }
    Ok(pos - at)
}

fn write_list_items(items: &LoroList, events: &[Event]) -> Result<()> {
    let mut pos = 0;
    let mut i = 0;
    while i < events.len() {
        if matches!(&events[i], Event::Start(Tag::Item)) {
            let end = find_end(events, i);
            let item = items.insert_container(pos, LoroMap::new())?;
            item.insert(KEY_NODE_NAME, LIST_ITEM)?;
            let item_children = item.ensure_mergeable_list(KEY_CHILDREN)?;
            // A tight list item's content isn't wrapped in its own
            // `Paragraph` event by pulldown-cmark — wrap it in one here so
            // it round-trips through the same paragraph-shaped node
            // `render_list_item_inline` expects on read.
            let para = item_children.insert_container(0, LoroMap::new())?;
            para.insert(KEY_NODE_NAME, PARAGRAPH)?;
            let para_children = para.ensure_mergeable_list(KEY_CHILDREN)?;
            let inner = &events[i + 1..end];
            let inline_events = if matches!(inner.first(), Some(Event::Start(Tag::Paragraph))) {
                let pend = find_end(inner, 0);
                &inner[1..pend]
            } else {
                inner
            };
            write_inline(&para_children, inline_events)?;
            pos += 1;
            i = end + 1;
        } else {
            i += 1;
        }
    }
    Ok(())
}

/// Writes a run of inline events (text with marks, and `@{heading-id}`
/// links, which pulldown-cmark itself doesn't know about — see
/// `split_link_refs`) as loro-prosemirror-shaped children: consecutive
/// marked text becomes runs of `LoroText` with `mark()` calls per span,
/// interrupted by `linkRef` atom nodes wherever `@{...}` appears.
#[allow(unused_assignments)] // `pos`'s final bump (inside `flush_run!`) has nothing left to read it — harmless.
fn write_inline(children: &LoroList, events: &[Event]) -> Result<()> {
    let mut active: Vec<&'static str> = Vec::new();
    // (text, marks-active-for-this-run) spans, flushed into one LoroText
    // per contiguous run between linkRef atoms.
    let mut run: Vec<(String, Vec<&'static str>)> = Vec::new();
    let mut pos = 0usize;

    // Marks default to Loro's "after" expand policy: a range, once marked,
    // absorbs whatever text is inserted right after it. Marking span N
    // before span N+1's (unmarked) text even exists yet would make N+1
    // silently inherit N's marks the moment it's inserted next to it — so
    // every span's text has to land first, *then* marks get applied in a
    // second pass over text that's already fully in place, once there's
    // nothing left to insert for expansion to catch.
    macro_rules! flush_run {
        () => {
            if !run.is_empty() {
                let text = children.insert_container(pos, LoroText::new())?;
                let spans = std::mem::take(&mut run);
                let full: String = spans.iter().map(|(s, _)| s.as_str()).collect();
                text.insert(0, &full)?;

                let mut offset = 0usize;
                for (s, marks) in &spans {
                    let len = s.chars().count();
                    for mark in marks {
                        text.mark(offset..offset + len, mark, true)?;
                    }
                    offset += len;
                }
                pos += 1;
            }
        };
    }

    for event in events {
        match event {
            Event::Start(Tag::Strong) => active.push("bold"),
            Event::End(TagEnd::Strong) => active.retain(|m| *m != "bold"),
            Event::Start(Tag::Emphasis) => active.push("italic"),
            Event::End(TagEnd::Emphasis) => active.retain(|m| *m != "italic"),
            Event::Start(Tag::Strikethrough) => active.push("strike"),
            Event::End(TagEnd::Strikethrough) => active.retain(|m| *m != "strike"),
            Event::Code(t) => run.push((t.to_string(), {
                let mut m = active.clone();
                m.push("code");
                m
            })),
            Event::Text(t) => {
                for (chunk, target) in split_link_refs(t) {
                    if let Some(target_id) = target {
                        flush_run!();
                        let link = children.insert_container(pos, LoroMap::new())?;
                        link.insert(KEY_NODE_NAME, LINK_NODE_NAME)?;
                        let attrs = link.ensure_mergeable_map(KEY_ATTRIBUTES)?;
                        attrs.insert(ATTR_ID, uuid::Uuid::new_v4().to_string().as_str())?;
                        attrs.insert(ATTR_TARGET_ID, target_id.as_str())?;
                        pos += 1;
                    } else if !chunk.is_empty() {
                        run.push((chunk, active.clone()));
                    }
                }
            }
            Event::SoftBreak | Event::HardBreak => run.push(("\n".to_string(), active.clone())),
            _ => {}
        }
    }
    flush_run!();
    Ok(())
}

/// Splits `text` on this module's `@{heading-id}` link syntax, yielding
/// `(chunk, Some(target_id))` for a link and `(chunk, None)` for plain
/// text in between.
fn split_link_refs(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("@{") {
        if start > 0 {
            out.push((rest[..start].to_string(), None));
        }
        let Some(end) = rest[start..].find('}') else {
            out.push((rest[start..].to_string(), None));
            return out;
        };
        let id = &rest[start + 2..start + end];
        if let Some(stripped) = id.strip_prefix("deleted:") {
            // A round-tripped orphaned link — nothing to point at, so it's
            // written back as plain text of its last known title rather
            // than a dangling reference.
            out.push((format!("@{stripped}"), None));
        } else {
            out.push((String::new(), Some(id.to_string())));
        }
        rest = &rest[start + end + 1..];
    }
    if !rest.is_empty() {
        out.push((rest.to_string(), None));
    }
    out
}

fn heading_level_number(level: HeadingLevel) -> i64 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// A small id for "what kind of Start/End pair is this", shared across the
/// `Tag`/`TagEnd` split — used to correctly find a Start event's matching
/// End even when same-kind blocks nest (a list inside a list, a blockquote
/// inside a blockquote, ...), which counting *any* `Start`/`End` as one
/// depth counter would get wrong (a nested block of a *different* kind
/// between them would desync the count).
fn block_kind(event: &Event) -> Option<u8> {
    match event {
        Event::Start(Tag::Heading { .. }) | Event::End(TagEnd::Heading(_)) => Some(1),
        Event::Start(Tag::Paragraph) | Event::End(TagEnd::Paragraph) => Some(2),
        Event::Start(Tag::CodeBlock(_)) | Event::End(TagEnd::CodeBlock) => Some(3),
        Event::Start(Tag::BlockQuote(_)) | Event::End(TagEnd::BlockQuote(_)) => Some(4),
        Event::Start(Tag::List(_)) | Event::End(TagEnd::List(_)) => Some(5),
        Event::Start(Tag::Item) | Event::End(TagEnd::Item) => Some(6),
        Event::Start(Tag::Strong) | Event::End(TagEnd::Strong) => Some(7),
        Event::Start(Tag::Emphasis) | Event::End(TagEnd::Emphasis) => Some(8),
        Event::Start(Tag::Strikethrough) | Event::End(TagEnd::Strikethrough) => Some(9),
        _ => None,
    }
}

/// Index of the `End` matching the `Start` at `events[start]`, accounting
/// for same-kind nesting in between (see `block_kind`).
fn find_end(events: &[Event], start: usize) -> usize {
    let Some(kind) = block_kind(&events[start]) else { return events.len().saturating_sub(1) };
    let mut depth = 0i32;
    for (i, event) in events.iter().enumerate().skip(start + 1) {
        if block_kind(event) != Some(kind) {
            continue;
        }
        match event {
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                if depth == 0 {
                    return i;
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    events.len().saturating_sub(1)
}
