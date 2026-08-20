import { useState } from "react";
import { useAppState } from "../../lib/AppState";
import { useDialog } from "../../adapters/dialog/context";
import { folderNameFromPath } from "../../lib/path";
import { LogoIcon, SyncProviderIcon } from "../../ui/icons";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import "./onboarding.css";

interface WorkspaceOnboardingProps {
  /** When set, an existing workspace is still active and this flow is
   * re-entrant (opened via "File > New Workspace") — show a way back out
   * instead of trapping the user in workspace creation. */
  onCancel?: () => void;
}

export function WorkspaceOnboarding({ onCancel }: WorkspaceOnboardingProps) {
  const { createWorkspace } = useAppState();
  const dialog = useDialog();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const defaultName = rootPath ? folderNameFromPath(rootPath) : "";

  async function handleChooseFolder() {
    const selected = await dialog.pickFolder();
    if (selected) setRootPath(selected);
  }

  async function handleCreate() {
    if (!rootPath || creating) return;
    setCreating(true);
    try {
      await createWorkspace({ name: name.trim() || defaultName, rootPath });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding__panel">
        <div className="onboarding__brand">
          <LogoIcon size={20} />
          <span className="onboarding__wordmark">Dendroid</span>
        </div>

        <div className="onboarding__heading">
          <span className="onboarding__title">Create a workspace</span>
          <p className="onboarding__subtitle">
            Choose the folder Dendroid should read and write your notes to. It supports concurrent readers and
            writers, so Dropbox, iCloud Drive, or a shared network folder all work.
          </p>
        </div>

        <div className="onboarding__step">
          <Field
            label="Root path"
            value={rootPath}
            readOnly
            placeholder="Choose a folder…"
            trailing={
              <Button variant="secondary" onClick={handleChooseFolder} style={{ flex: "none" }}>
                Choose…
              </Button>
            }
          />
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName || "Workspace name"}
            hint="Optional — defaults to the folder name."
          />
        </div>

        <div className="onboarding__footer">
          {onCancel && (
            <Button variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <div className="onboarding__footer-spacer" />
          <Button variant="primary" disabled={!rootPath || creating} onClick={handleCreate}>
            <SyncProviderIcon size={14} />
            {creating ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </div>
    </div>
  );
}
