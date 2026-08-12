import type { SyncProviderKind } from "./types";

export interface SyncProviderMeta {
  kind: SyncProviderKind;
  label: string;
  description: string;
  available: boolean;
}

// Mirrors comp/Dendroid Screens.dc.html "Sync" section and whitepaper.md's
// provider list. File is the only one wired up; the rest render as
// disabled "Coming soon" rows/cards until they exist.
export const SYNC_PROVIDERS: SyncProviderMeta[] = [
  {
    kind: "file",
    label: "File system",
    description: "Stored locally on disk. Store in a cloud-synced folder for free multi-device sync.",
    available: true,
  },
  {
    kind: "vault",
    label: "Vault",
    description: "Sync with end-to-end encryption · $1/mo",
    available: false,
  },
  {
    kind: "cloud",
    label: "Cloud",
    description: "Login, web access, sharing, MCP · $1/mo, team pricing 3+",
    available: false,
  },
  {
    kind: "git",
    label: "Git",
    description: "Encrypted notes to any Git remote",
    available: false,
  },
  {
    kind: "github",
    label: "GitHub",
    description: "Git with OAuth login",
    available: false,
  },
];
