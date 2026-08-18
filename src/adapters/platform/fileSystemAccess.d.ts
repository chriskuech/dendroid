// Ambient types for the bits of the File System Access API missing from
// TypeScript's bundled `lib.dom.d.ts` — the directory-picker entry point
// and the two `FileSystemHandle` permission methods. `dialog.ts` and
// `platform/wasm.ts` are the only callers; `FileSystemDirectoryHandle`
// itself is already declared upstream.

type FileSystemPermissionMode = "read" | "readwrite";

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: FileSystemPermissionMode;
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
