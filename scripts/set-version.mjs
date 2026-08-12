// Stamps a release version into every manifest that carries one, so a
// build produced by `.github/workflows/release.yml` reports the version
// the release is tagged with rather than the placeholder committed in
// git. Run from the repo root:
//   node scripts/set-version.mjs 0.2.0
// CI-only by design — it rewrites working-tree files and nothing commits
// the result.

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`usage: node scripts/set-version.mjs <major.minor.patch> (got: ${version ?? "nothing"})`);
  process.exit(1);
}

/** Rewrites the top-level `"version"` of a JSON manifest in place. */
function stampJson(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${path} -> ${version}`);
}

/** Matches only the `version = "..."` line of a Cargo manifest's
 * `[package]` section — a blunt full-file regex would also clobber
 * dependency version pins. */
const PACKAGE_VERSION = /^(\[package\][^[]*?^version\s*=\s*")[^"]*(")/ms;

function stampCargo(path) {
  const original = readFileSync(path, "utf8");
  // Tests the pattern rather than comparing the result: stamping the
  // version the file already carries is a legitimate no-op (it happens on
  // the very first release, where the computed version *is* the one in
  // the tree), and a `stamped === original` check would misread that
  // success as "no [package] version found".
  if (!PACKAGE_VERSION.test(original)) {
    console.error(`failed to find a [package] version in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, original.replace(PACKAGE_VERSION, `$1${version}$2`));
  console.log(`${path} -> ${version}`);
}

stampJson("package.json");
// The bundled app's version (installer names, Windows file properties,
// macOS Info.plist) comes from here.
stampJson("src-tauri/tauri.conf.json");
stampCargo("src-tauri/Cargo.toml");
