// The enable-encryption prompt ("create a key, or add one from a QR code
// / pasted text") and the "Show QR to pair" flow for a key that's already
// set — one component, several steps, since both end up at the same "show
// a key ready to hand to another device" screen. Mounted/unmounted by the
// caller (`EncryptionSection.tsx`) rather than kept alive with an `open`
// prop the way `ui/ConfirmDialog.tsx` is — unlike that dialog, the "scan"
// step holds a live camera stream, and unmounting is the simplest way to
// guarantee it always stops (see the `scan` step's effect cleanup).
//
// Backdrop/panel visual language matches `ConfirmDialog` (same blur-less
// simplification is a deliberate scope cut, not an oversight: this modal
// has several steps, so the asymmetric entrance/exit motion that dialog
// uses for a single confirm/cancel pair didn't seem worth reproducing
// here).

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import QRCode from "qrcode";
import type { DendroidDocument } from "../../lib/crdt/document";
import type { EncryptionStatusDto } from "../../lib/crdt/encryption";
import { CameraIcon, CloseIcon, EncryptionIcon, QrKeyIcon } from "../../ui/icons";
import { Button } from "../../ui/Button";
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from "../../ui/Dialog";
import "./settings.css";

type Step = "choose" | "generating" | "show" | "scan" | "paste";

export interface EncryptionModalProps {
  crdt: DendroidDocument;
  /** "choose" is the enable-encryption prompt; "show" jumps straight to
   * displaying `initialKeyText`'s QR/text — "Show QR to pair" from a
   * device that already has a key. */
  initialStep: "choose" | "show";
  initialKeyText?: string;
  initialFingerprint?: string | null;
  onClose: () => void;
  /** Called whenever a key is created, paired, or pasted successfully —
   * lets the caller refresh whatever status card is showing behind this
   * modal without waiting for the next poll tick. */
  onStatusChange: (status: EncryptionStatusDto) => void;
}

export function EncryptionModal({
  crdt,
  initialStep,
  initialKeyText,
  initialFingerprint,
  onClose,
  onStatusChange,
}: EncryptionModalProps) {
  const [step, setStep] = useState<Step>(initialStep);
  const [keyText, setKeyText] = useState(initialKeyText ?? "");
  const [fingerprint, setFingerprint] = useState<string | null>(initialFingerprint ?? null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);

  // Render (or re-render) the QR code whenever there's key text to show.
  useEffect(() => {
    if (step !== "show" || !keyText) return;
    let cancelled = false;
    QRCode.toDataURL(keyText, { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [step, keyText]);

  const applyKeyText = useCallback(
    async (text: string) => {
      setBusy(true);
      setError(null);
      try {
        const status = await crdt.setEncryptionKey(text);
        onStatusChange(status);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [crdt, onStatusChange, onClose],
  );

  // Live camera scanning — a `<video>` fed by `getUserMedia`, sampled onto
  // a hidden canvas every frame and decoded with jsQR. Stops the moment
  // this effect's cleanup runs (leaving `scan`, or the whole modal
  // unmounting) — a QR scanner is the one place in this app that asks for
  // camera access, so it must never keep it a moment longer than the
  // scanner is actually on screen.
  useEffect(() => {
    if (step !== "scan") return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let frame: number | null = null;
    const canvas = document.createElement("canvas");

    function tick() {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(image.data, image.width, image.height);
          if (result?.data) {
            void applyKeyText(result.data);
            return; // decoded — the stream stops via this same cleanup once `step` changes off "scan"
          }
        }
      }
      frame = requestAnimationFrame(tick);
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play();
        }
        frame = requestAnimationFrame(tick);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [step, applyKeyText]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    setStep("generating");
    try {
      const result = await crdt.generateEncryptionKey();
      setKeyText(result.keyText);
      setFingerprint(result.status.fingerprint);
      onStatusChange(result.status);
      setStep("show");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("choose");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(keyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied — nothing more we can do here
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogPortal>
        <DialogOverlay
          className="confirm-dialog__backdrop"
          style={{ opacity: 1, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
        />
        <DialogContent className="encryption-modal" aria-describedby={undefined}>
          <div className="confirm-dialog__header">
            <EncryptionIcon size={16} style={{ color: "var(--accent)" }} />
            <DialogTitle asChild>
              <span className="encryption-modal__title">
                {step === "choose" && "Enable encryption"}
                {step === "generating" && "Creating a key…"}
                {step === "show" && "Pair a device"}
                {step === "scan" && "Scan a QR code"}
                {step === "paste" && "Add a key"}
              </span>
            </DialogTitle>
            <DialogClose asChild>
              <button type="button" className="settings__header-close" aria-label="Close">
                <CloseIcon size={16} />
              </button>
            </DialogClose>
          </div>

        {step === "choose" && (
          <>
            <p className="confirm-dialog__body">
              Notes will be encrypted with a key that only lives on your devices. Create a new key on this device, or
              pair with one another device already has.
            </p>
            <div className="encryption-modal__choices">
              <Button variant="primary" onClick={() => void handleCreate()} disabled={busy}>
                <EncryptionIcon size={16} />
                Create a new key
              </Button>
              <Button variant="secondary" onClick={() => setStep("scan")} disabled={busy}>
                <CameraIcon size={16} />
                Scan a QR code
              </Button>
              <Button variant="secondary" onClick={() => setStep("paste")} disabled={busy}>
                <QrKeyIcon size={16} />
                Paste a key
              </Button>
            </div>
          </>
        )}

        {step === "generating" && <p className="confirm-dialog__body">Generating a new encryption key…</p>}

        {step === "show" && (
          <>
            <p className="confirm-dialog__body">
              Scan with dendroid on the other device. The code carries the encryption key and nothing else.
            </p>
            <div className="encryption-modal__qr">{qrDataUrl && <img src={qrDataUrl} alt="Encryption key QR code" width={240} height={240} />}</div>
            {fingerprint && <span className="encryption-modal__fingerprint">{fingerprint}</span>}
            <div className="field">
              <span className="field__label">Textual key</span>
              <div className="settings__code-row">
                <pre className="settings__code">{keyText}</pre>
                <Button variant="secondary" onClick={() => void handleCopy()} style={{ flex: "none" }}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <div className="confirm-dialog__footer">
              <Button variant="primary" onClick={onClose} style={{ marginLeft: "auto" }}>
                Done
              </Button>
            </div>
          </>
        )}

        {step === "scan" && (
          <>
            <p className="confirm-dialog__body">Point the camera at the QR code shown on the other device.</p>
            <video ref={videoRef} className="encryption-modal__video" muted playsInline />
            <div className="confirm-dialog__footer">
              <Button variant="secondary" onClick={() => setStep("choose")}>
                Back
              </Button>
            </div>
          </>
        )}

        {step === "paste" && (
          <>
            <p className="confirm-dialog__body">Paste the textual key copied from another device.</p>
            <textarea
              className="encryption-modal__textarea"
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder="dendroid-key1:…"
              rows={3}
              autoFocus
            />
            <div className="confirm-dialog__footer">
              <Button variant="secondary" onClick={() => setStep("choose")} disabled={busy}>
                Back
              </Button>
              <Button variant="primary" onClick={() => void applyKeyText(pasteValue.trim())} disabled={busy || !pasteValue.trim()}>
                {busy ? "Adding…" : "Add key"}
              </Button>
            </div>
          </>
        )}

        {error && <div className="encryption-modal__error">{error}</div>}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
