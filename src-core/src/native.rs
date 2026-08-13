//! `std::fs`-backed `LedgerStorage` — used by every native host (Tauri
//! today; a future CLI/MCP server would reuse it too). Not available on
//! `wasm32-unknown-unknown`; the web build uses `dendroid-web`'s File
//! System Access-backed impl instead (see `crate::storage::LedgerStorage`).

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use crate::doc::DendroidDocument;
use crate::error::{DendroidError, Result};
use crate::sqldb::SqlWorkspace;
use crate::storage::LedgerStorage;

fn io_err(path: &Path, source: std::io::Error) -> DendroidError {
    DendroidError::Io { path: path.to_path_buf(), source }
}

/// Ledger files under one directory — one per workspace. The directory
/// isn't created until the first `append`.
pub struct NativeLedgerStorage {
    dir: PathBuf,
}

impl NativeLedgerStorage {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// `workspace_root/ledger`, the convention every native host uses.
    pub fn for_workspace(workspace_root: &Path) -> Self {
        Self::new(workspace_root.join("ledger"))
    }

    /// `workspace_root/db-ledger` — the SQL database store's own directory,
    /// deliberately separate from `for_workspace`'s `ledger/` so a
    /// `sqldb::DbEvent` line never lands in the same file (and same
    /// `LedgerCursor<LoroUpdate>` parse attempt) a markdown-tree
    /// `LoroUpdate` line does. See `sqldb`'s module doc comment.
    pub fn for_databases(workspace_root: &Path) -> Self {
        Self::new(workspace_root.join("db-ledger"))
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl LedgerStorage for NativeLedgerStorage {
    async fn list_files(&self) -> Result<Vec<String>> {
        if !self.dir.exists() {
            return Ok(Vec::new());
        }
        let mut names: Vec<String> = fs::read_dir(&self.dir)
            .map_err(|e| io_err(&self.dir, e))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("log"))
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_string))
            .collect();
        names.sort();
        Ok(names)
    }

    async fn len(&self, name: &str) -> Result<u64> {
        let path = self.path(name);
        if !path.exists() {
            return Ok(0);
        }
        Ok(fs::metadata(&path).map_err(|e| io_err(&path, e))?.len())
    }

    async fn read_from(&self, name: &str, offset: u64) -> Result<Vec<u8>> {
        let path = self.path(name);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut file = File::open(&path).map_err(|e| io_err(&path, e))?;
        let len = file.metadata().map_err(|e| io_err(&path, e))?.len();
        if offset >= len {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(offset)).map_err(|e| io_err(&path, e))?;
        let mut buf = Vec::with_capacity((len - offset) as usize);
        file.read_to_end(&mut buf).map_err(|e| io_err(&path, e))?;
        Ok(buf)
    }

    async fn append(&self, name: &str, bytes: &[u8]) -> Result<()> {
        fs::create_dir_all(&self.dir).map_err(|e| io_err(&self.dir, e))?;
        let path = self.path(name);
        let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| io_err(&path, e))?;
        file.write_all(bytes).map_err(|e| io_err(&path, e))?;
        file.flush().map_err(|e| io_err(&path, e))?;
        // fsync'd so the write is durable and promptly visible to sync
        // engines (iCloud Drive, etc.) watching the file.
        file.sync_data().map_err(|e| io_err(&path, e))?;
        Ok(())
    }
}

/// The common native case: a `DendroidDocument` backed by real files under
/// `{workspace_root}/ledger/`.
pub type NativeDocument = DendroidDocument<NativeLedgerStorage>;

/// Convenience over `DendroidDocument::open(NativeLedgerStorage::for_workspace(root), ..)`.
pub async fn open_native(workspace_root: &Path, session_id: impl Into<String>) -> Result<NativeDocument> {
    DendroidDocument::open(NativeLedgerStorage::for_workspace(workspace_root), session_id).await
}

/// The common native case for the SQL database store: a `SqlWorkspace`
/// backed by real files under `{workspace_root}/db-ledger/`.
pub type NativeSqlWorkspace = SqlWorkspace<NativeLedgerStorage>;

/// Convenience over `SqlWorkspace::open(NativeLedgerStorage::for_databases(root), ..)`.
pub async fn open_native_sql(workspace_root: &Path, session_id: impl Into<String>) -> Result<NativeSqlWorkspace> {
    SqlWorkspace::open(NativeLedgerStorage::for_databases(workspace_root), session_id).await
}
