# Dendroid

Dendroid (`dendroid.app` ) is a native Markdown note-taking app. It reimagines your notes as a markdown graph rather than collection of pages—store your thoughts freeflow, relationally like a mindmap, without worrying about rigid structure. You can link to any heading in your notes and drill down through its linked heading.

- Your notes are one giant Markdown graph
    - Child headings are implicit links to their parent (ex: `##` is a child of `#`)
    - `@`-link to any heading in the app
        - typeahead completion of headings, ordered by their distance from the current block
    - “Tree view” of headers in the notes
        - Can click a button on the Tree view node to set as the root of the editor view
        - Can click a button to reset editor back to root view
- Generic sync providers
    - Support different sync options out of the box
- Security/privacy-first
    - Optional E2E encryption
    - No required cloud services
    - Optional cloud services including E2E encryption
- Optional cloud integration
    - For syncing
    - For sharing, team SKU
    - For MCP

## Brand

Ultra-modern, ultra-minimalist.

The UI fades away when unneeded for maximal focus.

Modals deblur in and their backgrounds blur in, and inverse going out.

1px-thick pixel art icons (no antialiasing).

Thin monospace brand font.

Very clean font choice for the editor that maximizes readability (perhaps have option to default to system).

### Logo

Following our aesthetic guidance on iconography,—

- A classic mathematical tree (root at the top), perfectly symmetrical/equal branching
- Drawn with 1px lines not-antialiased—digital minimalist look

# App

## Stack

- App framework — tauri
- Language — TypeScript (UX), Rust (core)
- Markdown editor — TipTap
- Tree view — perhaps `react-complex-tree` or `react-arborist`

## UX

- Tree
    - Serves as a navigation menu for the editor
    - Toggle expand/collapse nodes in the tree
    - Possibly uses our logo as the icon
    - Can click a button on the Tree view node to set as the root of the editor view
    - Can click a button to reset editor back to root view
    - Some link or button discrete but available: create or open another tree.
- Editor
    - TipTap editor scoped to the current tree
- Graph
    - Mindmap visualization of Tree
    - Draw parent/child links and `@`-links
- Account
    - Theme
        - Set “Aesthetic” preference—
            - Terminal —
                - Colors: true black/white background, strict grayscale (with bold accent colors as appropriate)
                - Feeling: sleek, modern, engaging but not distracting, flow state
                - Inspiration: Linear, a terminal running https://github.com/subnixr/minimal zsh theme
            - Parchment —
                - Colors: warmer tones, but still mostly white/black
                - Feeling: calming, meditative, relaxing
                - Inspiration: Zen gardens, author writing on paper at a wooden desk
        - Set “Color” preference—
            - Dark/Light/System
    - Editor
        - Mode
            - Zen — when cursor moves to the Editor, other UI elements outside the editor fade out, then fade in upon movement
            - Overlay — UI elements stay visible
        - Depth of descendants to show in the UI
            - (counter UI with +/- controls)
        - Use system font
            - switch
    - Local MCP
        - Whatever fields/controls are required to configure the app as a local MCP server.
    - Encryption
        - If no encryption key set,
            - Button to open a QR scanner to get the encryption key
        - If encryption key set,
            - Preview of the public key (for identifying the key)
            - Button to opens a QR code that you scan with your app
            - QR code contains the encryption key for the app to use
    - Sync
        - Initial Providers
            - File - supports concurrent readers and writers to disk
        - Future Providers (show as “Coming Soon”)
            - Vault — our future Vault service. Sync with E2E encryption.
            - Cloud — Sync with user login, web access, MCP server, secure sharing, distributed editing, encryption at rest. Team SKUs.
            - Git — writes encrypted notes to Git server (requires authentication)
            - GitHub — Git but with GitHub OAuth login and configuration

### Core

- Tree CRDT persisted built from a transaction log
- Sync providers
    - Generic interface for reading and writing the transaction log
        - Must support multiple writers
            - Ex: if using a file share with “File” sync provider, then must assume others are writing to the same folder (partition files by sessionId, watch for new files, watch for new changes in each session’s latest file)
- Encryption
    - Encryption key is stored securely internally
    - Each log event is stored with its markdown content encrypted

# Services

The app is free and does not require services or login for functioning.

We sell (mutually exclusive) subscriptions to sync providers for $1/mo.

- Vault — Sync with E2E encryption.
- Cloud — Sync with user login, web access, MCP server, secure sharing, distributed editing, encryption at rest.
    - Team pricing for 3+ people on a tree
