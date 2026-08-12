// Platform-agnostic logic lives in the `dendroid-core` crate (src-core/).
// This crate is the web build's counterpart to `src-tauri/src/lib.rs`; the
// actual binding surface lives in `commands.rs`, same split as that crate's
// `commands.rs`/`state.rs`.

mod commands;
mod fsa;

pub use commands::WebDocument;
