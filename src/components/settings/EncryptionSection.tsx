// Settings' "Workspace > Encryption" subsection — wires up the
// placeholder that used to live directly in `SettingsPage.tsx` (see the
// whitepaper's encryption section for the design this implements): enable
// encryption (create a key, or pair from a QR code / pasted text), show
// the current key's QR for pairing another device, and the "Remove key"
// danger-zone action `ui/ConfirmDialog.tsx` was originally built for.

import { useEffect, useState } from "react";
import type { DendroidDocument } from "../../lib/crdt/document";
import type { EncryptionStatusDto } from "../../lib/crdt/encryption";
import { loadEncryptionKeyText } from "../../lib/settingsStore";
import { EncryptionIcon, QrKeyIcon } from "../icons";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EncryptionModal } from "./EncryptionModal";

const NO_STATUS: EncryptionStatusDto = { enabled: false, fingerprint: null, blockedReason: null };

interface EncryptionSectionProps {
  /** `null` while no workspace is open yet — encryption has nothing to
   * apply to until then, so every control here stays disabled. */
  crdt: DendroidDocument | null;
}

type ModalState = { step: "choose" } | { step: "show"; keyText: string };

export function EncryptionSection({ crdt }: EncryptionSectionProps) {
  const [status, setStatus] = useState<EncryptionStatusDto>(NO_STATUS);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!crdt) {
      setStatus(NO_STATUS);
      return;
    }
    void crdt.encryptionStatus().then(setStatus);
    return crdt.onEncryptionStatusChange(setStatus);
  }, [crdt]);

  async function openShowQr() {
    // The key text itself only ever lives in the frontend's own persisted
    // settings (see `settingsStore.ts`'s `ENCRYPTION_KEY_KEY`) — the
    // backend never hands raw key material back out except right when a
    // key is first created (`generateEncryptionKey`'s return value).
    const keyText = await loadEncryptionKeyText();
    if (keyText) setModal({ step: "show", keyText });
  }

  function handleRemove() {
    if (!crdt) return;
    void crdt.removeEncryptionKey().then(() => setConfirmingRemove(false));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span className="settings__subsection-title">Encryption</span>
      <div className="card-grid">
        <div className="card" style={{ cursor: "default" }}>
          <div className="card__head">
            <EncryptionIcon size={16} />
            <span className="card__title" style={{ color: status.enabled ? "var(--text)" : "var(--text-2)" }}>
              {status.enabled ? status.fingerprint : "No key set"}
            </span>
          </div>
          <span className="card__desc">
            {status.enabled
              ? "Notes are encrypted with this key before they're written to disk."
              : "Notes are stored unencrypted on this device."}
          </span>
          {status.enabled ? (
            <Button variant="secondary" onClick={() => void openShowQr()} style={{ width: "fit-content" }}>
              <QrKeyIcon size={16} />
              Show QR to pair
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setModal({ step: "choose" })} disabled={!crdt} style={{ width: "fit-content" }}>
              <QrKeyIcon size={16} />
              Enable encryption
            </Button>
          )}
        </div>
      </div>

      <span className="settings__block-hint" style={status.blockedReason ? { color: "var(--danger)" } : undefined}>
        {status.blockedReason ??
          (status.enabled
            ? "Pair another device by showing it this device's QR code, or copy/paste the textual key."
            : "Optional end-to-end encryption — a key that only ever lives on your own devices, never sent anywhere.")}
      </span>

      {status.enabled && (
        <div className="settings__danger">
          <span className="settings__danger-copy">
            Removing the key deletes access to every past note it encrypted. Dendroid cannot recover it, and no copy is
            held anywhere else.
          </span>
          <Button variant="destructive" onClick={() => setConfirmingRemove(true)} style={{ flex: "none" }}>
            Remove key
          </Button>
        </div>
      )}

      {crdt && modal && (
        <EncryptionModal
          crdt={crdt}
          initialStep={modal.step}
          initialKeyText={modal.step === "show" ? modal.keyText : undefined}
          initialFingerprint={status.fingerprint}
          onClose={() => setModal(null)}
          onStatusChange={setStatus}
        />
      )}

      <ConfirmDialog
        open={confirmingRemove}
        icon={EncryptionIcon}
        title="Remove key"
        body="Every note already written with this key becomes unreadable on this device. Dendroid cannot recover it, and no copy is held anywhere else."
        details={status.fingerprint ? [{ label: "Key", value: status.fingerprint }] : undefined}
        confirmLabel="Remove key"
        onConfirm={handleRemove}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  );
}
