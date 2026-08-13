//! File System Access API backed `LedgerStorage` — the web build's answer
//! to `dendroid_core::native::NativeLedgerStorage`'s `std::fs`. Unlike
//! OPFS's origin-private sandbox, this points at a *real* directory the
//! user picked via `window.showDirectoryPicker()` (see the JS side's
//! `lib/dialog.ts`'s `pickFolder`) — the same folder a Tauri build of
//! this app could point at, so a browser tab and the native app merge
//! through the exact same ledger files, synced by iCloud Drive/Dropbox/
//! whatever the user already uses, no separate storage model at all.
//! `FileSystemDirectoryHandle`'s async, Promise-based API is why
//! `LedgerStorage`'s methods are `async` in the first place.
//!
//! `FileSystemDirectoryHandle` *is* asynchronously iterable in the
//! browser (`for await (const name of dir.keys())`), but that iterator
//! protocol has no ergonomic wasm-bindgen binding — `list_files` drives
//! `js_sys::AsyncIterator` by hand instead (`next()`, then pull `value`/
//! `done` back out of the resolved `{value, done}` object).

use dendroid_core::storage::LedgerStorage;
use dendroid_core::{DendroidError, Result};
use js_sys::Uint8Array;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    FileSystemCreateWritableOptions, FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemGetDirectoryOptions,
    FileSystemGetFileOptions, FileSystemWritableFileStream,
};

pub struct FsaLedgerStorage {
    dir: FileSystemDirectoryHandle,
}

impl FsaLedgerStorage {
    /// `root` is the user-picked workspace folder — already permitted for
    /// read/write (see `lib/dialog.ts`'s `pickFolder` and
    /// `lib/platform/wasm.ts`'s permission check, which run before this
    /// is ever called). Opens (creating if necessary) its `ledger/`
    /// subdirectory, matching every native host's convention.
    pub async fn open(root: FileSystemDirectoryHandle) -> Result<Self> {
        let dir = get_or_create_dir(&root, "ledger").await?;
        Ok(Self { dir })
    }

    async fn get_file(&self, name: &str, create: bool) -> Result<Option<FileSystemFileHandle>> {
        let opts = FileSystemGetFileOptions::new();
        opts.set_create(create);
        match promise::<FileSystemFileHandle>(self.dir.get_file_handle_with_options(name, &opts)).await {
            Ok(handle) => Ok(Some(handle)),
            // The File System Access spec throws `NotFoundError` for a
            // missing file when `create` is false; anything else getting
            // here is `create: true` failing, which is a real error.
            Err(_) if !create => Ok(None),
            Err(e) => Err(js_err(name, &e)),
        }
    }
}

impl LedgerStorage for FsaLedgerStorage {
    async fn list_files(&self) -> Result<Vec<String>> {
        let iter = self.dir.keys();
        let mut names = Vec::new();

        loop {
            let next = iter.next().map_err(|e| js_err("dir.keys()", &e))?;
            let result = promise::<JsValue>(next).await.map_err(|e| js_err("dir.keys()", &e))?;

            let done = js_sys::Reflect::get(&result, &JsValue::from_str("done")).map_err(|e| js_err("dir.keys()", &e))?;
            if done.as_bool().unwrap_or(false) {
                break;
            }

            let value = js_sys::Reflect::get(&result, &JsValue::from_str("value")).map_err(|e| js_err("dir.keys()", &e))?;
            if let Some(name) = value.as_string() {
                if name.ends_with(".log") {
                    names.push(name);
                }
            }
        }

        names.sort();
        Ok(names)
    }

    async fn len(&self, name: &str) -> Result<u64> {
        let Some(handle) = self.get_file(name, false).await? else {
            return Ok(0);
        };
        file_size(&handle).await
    }

    async fn read_from(&self, name: &str, offset: u64) -> Result<Vec<u8>> {
        let Some(handle) = self.get_file(name, false).await? else {
            return Ok(Vec::new());
        };
        let bytes = read_all(&handle).await?;
        Ok(if offset as usize >= bytes.len() { Vec::new() } else { bytes[offset as usize..].to_vec() })
    }

    async fn append(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let handle = self.get_file(name, true).await?.expect("create: true");
        let existing_len = file_size(&handle).await?;

        let opts = FileSystemCreateWritableOptions::new();
        opts.set_keep_existing_data(true);
        let writable = promise::<FileSystemWritableFileStream>(handle.create_writable_with_options(&opts))
            .await
            .map_err(|e| js_err(name, &e))?;

        promise::<JsValue>(writable.seek_with_f64(existing_len as f64).map_err(|e| js_err(name, &e))?)
            .await
            .map_err(|e| js_err(name, &e))?;

        let array = Uint8Array::from(bytes);
        promise::<JsValue>(writable.write_with_buffer_source(&array).map_err(|e| js_err(name, &e))?)
            .await
            .map_err(|e| js_err(name, &e))?;

        promise::<JsValue>(writable.close()).await.map_err(|e| js_err(name, &e))?;
        Ok(())
    }

    async fn write(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let handle = self.get_file(name, true).await?.expect("create: true");

        // No `keep_existing_data` option here (unlike `append`) — a fresh
        // writable stream truncates to empty by default, which is exactly
        // what a full overwrite wants.
        let writable = promise::<FileSystemWritableFileStream>(handle.create_writable()).await.map_err(|e| js_err(name, &e))?;

        let array = Uint8Array::from(bytes);
        promise::<JsValue>(writable.write_with_buffer_source(&array).map_err(|e| js_err(name, &e))?)
            .await
            .map_err(|e| js_err(name, &e))?;

        promise::<JsValue>(writable.close()).await.map_err(|e| js_err(name, &e))?;
        Ok(())
    }
}

async fn get_or_create_dir(parent: &FileSystemDirectoryHandle, name: &str) -> Result<FileSystemDirectoryHandle> {
    let opts = FileSystemGetDirectoryOptions::new();
    opts.set_create(true);
    promise(parent.get_directory_handle_with_options(name, &opts)).await.map_err(|e| js_err(name, &e))
}

async fn file_size(handle: &FileSystemFileHandle) -> Result<u64> {
    let file = promise::<web_sys::File>(handle.get_file()).await.map_err(|e| js_err("get_file", &e))?;
    Ok(file.size() as u64)
}

async fn read_all(handle: &FileSystemFileHandle) -> Result<Vec<u8>> {
    let file = promise::<web_sys::File>(handle.get_file()).await.map_err(|e| js_err("get_file", &e))?;
    let buffer = promise::<js_sys::ArrayBuffer>(file.array_buffer()).await.map_err(|e| js_err("array_buffer", &e))?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

/// Awaits a `Promise`-returning call and casts its resolved value.
async fn promise<T: JsCast>(p: js_sys::Promise) -> std::result::Result<T, JsValue> {
    JsFuture::from(p).await?.dyn_into::<T>()
}

fn js_err(location: &str, value: &JsValue) -> DendroidError {
    DendroidError::Storage { location: location.to_string(), reason: format!("{value:?}") }
}
