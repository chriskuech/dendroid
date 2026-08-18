// The frontend half of the CRDT <-> Ledger bridge.
//
//   TipTap (ProseMirror)  <--loro-prosemirror-->  LoroDoc (this mirror)
//                                                       |
//                                    doc.subscribeLocalUpdates (this session's edits)
//                                                       v
//                                     backend.importUpdate(bytes)  ---.
//                                                                     |
//                                          Rust DendroidDocument (native, over
//                                    Tauri IPC — or wasm, over the File System
//                                     Access API on web; see `adapters/platform`)
//                                       appends to the ledger file for this
//                                                    session
//                                                                     |
//                                       backend.onRemoteUpdate(...)  <'
//                                  (this call's result, or a ledger record
//                                   merged in from another session/replica)
//
// Every change this mirror learns about that it didn't originate itself
// arrives the same way: import the bytes `onRemoteUpdate` hands over.
// Which platform backend is actually behind that call (Tauri IPC, wasm)
// is `adapters/platform`'s problem, not this module's — see
// `adapters/platform/types.ts`'s `DocBackend` for the shared contract.
//
// There's no separate structural tree here either. `loroDoc.getMap("doc")`
// *is* the ProseMirror document — the same container `loro-prosemirror`'s
// default (unbound) `LoroSyncPlugin({ doc })` binds TipTap to — and the
// heading outline is derived from it on read (`snapshotOutline`), the same
// contract `dendroid_core::outline` implements on the Rust side. A heading
// and everything nested under it (body content, and further nested
// headings) live together in one `section` node — see that module's doc
// comment for the shape and why; `section`, not `heading`, is what carries
// the stable `id` these snapshots key rows by.

import { LoroDoc, getType, isContainer, type ContainerID, type LoroList, type LoroMap, type LoroText } from "loro-crdt";
import { createDocBackend } from "../../adapters/platform";
import type { DocBackend } from "../../adapters/platform/types";
import { adapter as settingsStore } from "../../adapters/settingsStore";
import type { EncryptionStatusDto, GeneratedEncryptionKey } from "./encryption";
import type { HistoryEntryDto } from "./history";
import type { HeadingDto, OutlineEntry } from "./outline";

const NO_BACKEND_WARNING =
  "[crdt] No platform backend available — running an in-memory, unpersisted document " +
  "(e.g. `vite dev` opened in a plain browser before `bun run build:wasm` has built the wasm " +
  "package). Nothing here will be saved.";

/** Encryption status doesn't ride along with `onUpdate` — a blocked poll
 * (see `dendroid_core::doc::DendroidDocument::poll_external`) produces no
 * document change to signal, so there's nothing for `onRemoteUpdate` to
 * fire on. Polled on this interval instead — see `open()`'s status
 * subscription below. Same cadence as the wasm backend's own external-poll
 * interval (`adapters/platform/wasm.ts`); no need to check more often than
 * sync itself runs. */
const ENCRYPTION_STATUS_POLL_MS = 1500;

const NO_ENCRYPTION_STATUS: EncryptionStatusDto = { enabled: false, fingerprint: null, blockedReason: null };

function encryptionStatusEqual(a: EncryptionStatusDto, b: EncryptionStatusDto): boolean {
  return a.enabled === b.enabled && a.fingerprint === b.fingerprint && a.blockedReason === b.blockedReason;
}

export class DendroidDocument {
  readonly doc = new LoroDoc();
  /** True once `open()` has run without a platform backend to talk to —
   * see `NO_BACKEND_WARNING`. Editing still works against this local-only
   * mirror (nothing persists), so the UI stays inspectable in a plain
   * browser preview. */
  isPreview = false;

  private backend: DocBackend | null = null;
  private stopLocalSubscription: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private encryptionListeners = new Set<(status: EncryptionStatusDto) => void>();
  private encryptionPollHandle: ReturnType<typeof setInterval> | null = null;
  private lastEncryptionStatus: EncryptionStatusDto = NO_ENCRYPTION_STATUS;

  constructor() {
    // Off by default in Loro. This mirror is where a local edit actually
    // commits (loro-prosemirror writes straight into `this.doc`, see
    // `open()` below), so it's the one place that needs to opt in for
    // `history()` entries from ordinary typing to carry a real timestamp —
    // see `dendroid_core::doc::DendroidDocument::open` for the Rust-side
    // half of this (its own local commits: MCP edits, migrations, rollbacks).
    this.doc.setRecordTimestamp(true);
  }

  /** Opens `workspaceRoot` against whichever platform backend
   * `createDocBackend` picks: the backend replays its ledger, hands back
   * a full snapshot to seed this mirror, and from then on this mirror
   * stays current via `onRemoteUpdate`. Falls back to an unpersisted
   * local-only document when there's no backend available to open a real
   * workspace against. */
  async open(workspaceRoot: string): Promise<void> {
    const backend = await createDocBackend();
    if (!backend) {
      console.warn(NO_BACKEND_WARNING);
      this.isPreview = true;
      this.notify();
      return;
    }
    this.backend = backend;

    const snapshot = await backend.open(workspaceRoot);
    this.doc.import(snapshot);
    this.notify();

    backend.onRemoteUpdate((bytes) => {
      this.doc.import(bytes);
      this.notify();
    });

    // This process/session is the sole ledger writer for whatever it
    // touches — including edits made locally through this JS-side mirror
    // (every TipTap edit, via loro-prosemirror) — so every local commit
    // gets forwarded to the backend to persist.
    //
    // This fires *after* the commit this mirror's own `doc` already
    // applied — loro-prosemirror writes straight into `this.doc`, so
    // there's nothing to wait on the backend round trip for — so this also
    // notifies listeners (the tree view's outline refresh) directly.
    // `import_from_frontend` on the Rust side deliberately marks this
    // session's frontend as already caught up before it reconciles
    // backlinks (see `dendroid_core::doc`'s doc comment), so
    // `onRemoteUpdate` above only fires for a *foreign* change or the rare
    // local edit whose backlink reconciliation added something new — a
    // plain local edit gets no echo at all, and without this call here the
    // tree would just go stale until one arrived.
    this.stopLocalSubscription = this.doc.subscribeLocalUpdates((bytes) => {
      this.notify();
      void backend.importUpdate(bytes).catch((err: unknown) => {
        console.error("[crdt] failed to persist local update", err);
      });
    });

    // Re-supply this device's encryption key (if it's ever set one) so
    // encrypted history decrypts right away rather than sitting blocked
    // until Settings is opened — see `adapters/settingsStore`'s
    // `loadEncryptionKeyText` (OS-keychain-backed under Tauri) for why the
    // key lives there rather than in `AppSettings`, and `dendroid_core::
    // doc::DendroidDocument::set_encryption_key` for why calling this
    // again is safe/idempotent.
    const keyText = await settingsStore.loadEncryptionKeyText();
    if (keyText) {
      try {
        await backend.setEncryptionKey(keyText);
      } catch (err) {
        console.error("[crdt] failed to re-apply saved encryption key", err);
      }
    }
    await this.refreshEncryptionStatus();
    this.encryptionPollHandle = setInterval(() => void this.refreshEncryptionStatus(), ENCRYPTION_STATUS_POLL_MS);
  }

  private async refreshEncryptionStatus(): Promise<void> {
    if (!this.backend) return;
    const status = await this.backend.encryptionStatus().catch((err: unknown) => {
      console.error("[crdt] failed to read encryption status", err);
      return null;
    });
    if (!status || encryptionStatusEqual(status, this.lastEncryptionStatus)) return;
    this.lastEncryptionStatus = status;
    for (const listener of this.encryptionListeners) listener(status);
  }

  /** Current encryption state, without waiting for the next poll tick —
   * what Settings' encryption panel reads on mount. `NO_ENCRYPTION_STATUS`
   * in preview mode (no backend to ask). */
  async encryptionStatus(): Promise<EncryptionStatusDto> {
    if (!this.backend) return NO_ENCRYPTION_STATUS;
    return this.backend.encryptionStatus();
  }

  /** Fires whenever encryption status changes — a key was set/removed, or
   * sync became blocked/unblocked — including once, right after `open()`
   * resolves, with whatever the initial state turns out to be. */
  onEncryptionStatusChange(callback: (status: EncryptionStatusDto) => void): () => void {
    this.encryptionListeners.add(callback);
    return () => this.encryptionListeners.delete(callback);
  }

  /** Turns on encryption with a freshly generated key ("create a key") and
   * persists its textual form (`adapters/settingsStore`) so it survives a
   * restart — see `DocBackend.generateEncryptionKey`. */
  async generateEncryptionKey(): Promise<GeneratedEncryptionKey> {
    if (!this.backend) throw new Error("[crdt] generateEncryptionKey called without a platform backend");
    const result = await this.backend.generateEncryptionKey();
    await settingsStore.saveEncryptionKeyText(result.keyText);
    await this.refreshEncryptionStatus();
    return result;
  }

  /** Turns on encryption with `keyText` — scanned from a QR code or
   * pasted — and persists it the same way `generateEncryptionKey` does.
   * See `DocBackend.setEncryptionKey`. */
  async setEncryptionKey(keyText: string): Promise<EncryptionStatusDto> {
    if (!this.backend) throw new Error("[crdt] setEncryptionKey called without a platform backend");
    const status = await this.backend.setEncryptionKey(keyText);
    await settingsStore.saveEncryptionKeyText(keyText);
    await this.refreshEncryptionStatus();
    return status;
  }

  /** Turns encryption off on this device and forgets the persisted key —
   * without clearing it, the next `open()` would just re-apply it. See
   * `DocBackend.removeEncryptionKey`. */
  async removeEncryptionKey(): Promise<void> {
    if (!this.backend) throw new Error("[crdt] removeEncryptionKey called without a platform backend");
    await this.backend.removeEncryptionKey();
    await settingsStore.clearEncryptionKeyText();
    await this.refreshEncryptionStatus();
  }

  /** Reads the heading outline directly out of this mirror — the live UI
   * uses this instead of the `doc_outline` Tauri command so a tree-view
   * refresh doesn't mean a round trip on every keystroke. Must stay in
   * lockstep with `dendroid_core::outline::outline`'s algorithm; see that
   * module's doc comment for the encoding contract both depend on. */
  snapshotOutline(): HeadingDto[] {
    const root = this.doc.getMap("doc");
    const children = getListValue(root, "children");
    if (!children) return [];

    const out: HeadingDto[] = [];
    walkSections(children, null, 0, out);
    return out;
  }

  /** Headings and `@`-links, interleaved in document order — what
   * TreeView needs to render both surfaces (see `dendroid_core::outline::
   * outline_with_links`, which this must stay in lockstep with the same
   * way `snapshotOutline` already stays in lockstep with `outline::
   * outline`). Unlike headings, `linkRef` nodes are inline content, so
   * finding them means recursing into a section's own body content rather
   * than just walking its direct children. */
  snapshotOutlineWithLinks(): OutlineEntry[] {
    const root = this.doc.getMap("doc");
    const children = getListValue(root, "children");
    if (!children) return [];

    const out: OutlineEntry[] = [];
    walkSectionsWithLinks(children, null, 0, out);
    return out;
  }

  /** The section's own Loro container id — a section's whole subtree
   * (its heading, body, and any nested subsections) lives inside this one
   * container (see `section.ts`'s/`dendroid_core::outline`'s doc
   * comments), so this is what an expanded `@`-link's preview binds a
   * live embedded editor to (`ux/editor/tiptap/embeddedEditor.ts`) instead of a
   * rebuilt-DOM snapshot. `undefined` if `id` isn't a section in the live
   * document right now (an orphaned/stale link, or one racing a deletion
   * that hasn't reconciled yet) — callers fall back to the read-only
   * preview in that case. */
  getSectionContainerId(id: string): ContainerID | undefined {
    const root = this.doc.getMap("doc");
    const children = getListValue(root, "children");
    return children ? findSectionContainerId(children, id) : undefined;
  }

  /** Every change in this document's history, most recent first — see
   * `HistoryEntryDto`. Empty when running without a platform backend
   * (`isPreview`): there's no ledger for anything to have been recorded
   * into. */
  history(): Promise<HistoryEntryDto[]> {
    if (!this.backend) return Promise.resolve([]);
    return this.backend.history();
  }

  /** Rolls the document back to `token` (from a previous `history()`
   * call). The backend appends the rollback to the ledger and reports the
   * resulting delta back through `onRemoteUpdate` (registered in `open()`
   * above), which imports it into this mirror and notifies listeners —
   * the same path any other backend-driven change already takes, so
   * there's nothing further to do here once the backend call resolves. */
  async revertTo(token: string): Promise<void> {
    if (!this.backend) throw new Error("[crdt] revertTo called without a platform backend — nothing to roll back");
    await this.backend.revertTo(token);
  }

  /** Fires after this mirror imports anything — its own local edits,
   * another session's edits, or a merge discovered on disk. */
  onUpdate(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
    this.stopLocalSubscription?.();
    this.stopLocalSubscription = null;
    this.listeners.clear();
    if (this.encryptionPollHandle !== null) clearInterval(this.encryptionPollHandle);
    this.encryptionPollHandle = null;
    this.encryptionListeners.clear();
  }
}

function getListValue(map: LoroMap, key: string): LoroList | undefined {
  const value = map.get(key);
  return isContainer(value) && getType(value) === "List" ? (value as LoroList) : undefined;
}

function getMapValue(map: LoroMap, key: string): LoroMap | undefined {
  const value = map.get(key);
  return isContainer(value) && getType(value) === "Map" ? (value as LoroMap) : undefined;
}

/** Recurses through `children` (the doc's own top-level list, or a
 * section's own children list), appending a `HeadingDto` for every
 * `section` found — mirrors `dendroid_core::outline`'s `walk_sections`.
 * `index` is naturally scoped per call (i.e. per parent), since each
 * recursive call only ever sees one parent's direct children. */
function walkSections(children: LoroList, parent: string | null, depth: number, out: HeadingDto[]): void {
  let index = 0;
  for (let i = 0; i < children.length; i++) {
    const entry = children.get(i);
    if (!isContainer(entry) || getType(entry) !== "Map") continue;
    const node = entry as LoroMap;
    if (node.get("nodeName") !== "section") continue;

    const sectionChildren = getListValue(node, "children");
    const heading = sectionChildren ? leadingHeading(sectionChildren) : undefined;
    if (!sectionChildren || !heading) continue;

    const attrs = getMapValue(node, "attributes");
    const rawId = attrs?.get("id");
    const id = typeof rawId === "string" ? rawId : `pos:${i}`;
    const headingAttrs = getMapValue(heading, "attributes");
    const rawLevel = headingAttrs?.get("level");
    const level = typeof rawLevel === "number" ? Math.min(Math.max(Math.trunc(rawLevel), 1), 255) : 1;
    const title = headingTitle(heading);

    out.push({ id, parent, index, depth, level, title });
    index += 1;

    walkSections(sectionChildren, id, depth + 1, out);
  }
}

/** Same walk as `walkSections`, but also finds every `linkRef` nested in
 * each section's own body content (a paragraph, a list, ...) and files it
 * right after the section that currently encloses it, one depth level
 * deeper — mirrors `dendroid_core::outline`'s `walk_sections_with_links`. */
function walkSectionsWithLinks(children: LoroList, parent: string | null, depth: number, out: OutlineEntry[]): void {
  let index = 0;
  for (let i = 0; i < children.length; i++) {
    const entry = children.get(i);
    if (!isContainer(entry) || getType(entry) !== "Map") continue;
    const node = entry as LoroMap;
    if (node.get("nodeName") !== "section") continue;

    const sectionChildren = getListValue(node, "children");
    const heading = sectionChildren ? leadingHeading(sectionChildren) : undefined;
    if (!sectionChildren || !heading) continue;

    const attrs = getMapValue(node, "attributes");
    const rawId = attrs?.get("id");
    const id = typeof rawId === "string" ? rawId : `pos:${i}`;
    const headingAttrs = getMapValue(heading, "attributes");
    const rawLevel = headingAttrs?.get("level");
    const level = typeof rawLevel === "number" ? Math.min(Math.max(Math.trunc(rawLevel), 1), 255) : 1;
    const title = headingTitle(heading);

    out.push({ kind: "heading", heading: { id, parent, index, depth, level, title } });
    index += 1;

    // Body content, one level deeper: any `@`-link nested inside a body
    // block (not itself a nested `section` — that's a child heading,
    // walked by the recursive call below) files under this section's own
    // id.
    for (let j = 1; j < sectionChildren.length; j++) {
      const bentry = sectionChildren.get(j);
      if (!isContainer(bentry) || getType(bentry) !== "Map") continue;
      const bnode = bentry as LoroMap;
      if (bnode.get("nodeName") === "section") continue;
      collectLinkEntries(bnode, id, depth + 1, out);
    }

    walkSectionsWithLinks(sectionChildren, id, depth + 1, out);
  }
}

/** A section's own leading `heading` child (its title), if its `children`
 * actually starts with one. */
function leadingHeading(sectionChildren: LoroList): LoroMap | undefined {
  const entry = sectionChildren.get(0);
  if (!isContainer(entry) || getType(entry) !== "Map") return undefined;
  const node = entry as LoroMap;
  return node.get("nodeName") === "heading" ? node : undefined;
}

/** Finds the `section` whose own `id` attribute is `id`, searching
 * `children` and every nested section inside it, depth-first — mirrors
 * `dendroid_core::markdown`'s `find_section`. */
function findSectionContainerId(children: LoroList, id: string): ContainerID | undefined {
  for (let i = 0; i < children.length; i++) {
    const entry = children.get(i);
    if (!isContainer(entry) || getType(entry) !== "Map") continue;
    const node = entry as LoroMap;
    if (node.get("nodeName") !== "section") continue;

    const attrs = getMapValue(node, "attributes");
    if (attrs?.get("id") === id) return node.id;

    const sectionChildren = getListValue(node, "children");
    if (sectionChildren) {
      const found = findSectionContainerId(sectionChildren, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Finds every `linkRef` nested anywhere inside `node` (`node` itself
 * included) and appends a positioned entry for each, in document order —
 * mirrors `dendroid_core::links::collect_link_entries`. */
function collectLinkEntries(node: LoroMap, parent: string | null, depth: number, out: OutlineEntry[]): void {
  if (node.get("nodeName") === "linkRef") {
    const attrs = getMapValue(node, "attributes");
    const rawId = attrs?.get("id");
    const rawTarget = attrs?.get("targetId");
    const rawStale = attrs?.get("staleTitle");
    out.push({
      kind: "link",
      link: {
        id: typeof rawId === "string" ? rawId : "",
        targetId: typeof rawTarget === "string" ? rawTarget : null,
        staleTitle: typeof rawStale === "string" ? rawStale : null,
        parent,
        depth,
      },
    });
  }

  const children = getListValue(node, "children");
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const entry = children.get(i);
    if (!isContainer(entry) || getType(entry) !== "Map") continue;
    collectLinkEntries(entry as LoroMap, parent, depth, out);
  }
}

/** Concatenates a heading node's own inline text content — headings only
 * contain inline content in practice, so no need to recurse into nested
 * block nodes. */
function headingTitle(node: LoroMap): string {
  const children = getListValue(node, "children");
  if (!children) return "";
  let title = "";
  for (let i = 0; i < children.length; i++) {
    const entry = children.get(i);
    if (isContainer(entry) && getType(entry) === "Text") title += (entry as LoroText).toString();
  }
  return title;
}
