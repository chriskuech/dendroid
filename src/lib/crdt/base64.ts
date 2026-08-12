// Tauri's `invoke` serializes command payloads as JSON, which has no
// binary type — so Loro update/snapshot bytes cross the IPC boundary as
// base64 strings. These helpers are the one place that encoding happens.
//
// The char-by-char loop is fine for note-sized documents; if updates ever
// get large enough for this to matter, swap in chunked
// `String.fromCharCode.apply` or a streaming base64 codec.

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
