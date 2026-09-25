# Project TODO

This file is the handoff queue for unfinished Excalidraw Visualizer work. Read
`AGENTS.md` before starting an item, keep this list current as work progresses,
and do not mark a platform supported until its packaged application has been
tested on that platform.

The first public Windows release is version `0.1.0`. Windows remains the only
packaged and advertised platform at this point.

## macOS support

macOS support is the next platform priority. Planning is recorded here for the
next agent working on a Mac; implementation has intentionally not started.

- [ ] Decide and document the initial macOS support matrix, including minimum
  macOS version and whether both Apple silicon and Intel are in scope.
- [ ] Verify the development workflow on a clean Mac with `npm ci`,
  `npm run check`, `npm run build`, and `npm run dev`.
- [ ] Add electron-builder macOS targets and platform-appropriate icons without
  changing or weakening the existing Windows targets.
- [ ] Verify the sandboxed CommonJS preload, offline Excalidraw assets, file
  dialogs, drag and drop, launch-path handling, watcher behavior, atomic saves,
  and conflict flow in a packaged macOS application.
- [ ] Add macOS packaging and packaged smoke coverage to GitHub Actions.
- [ ] Extend rolling and tagged releases with clearly named macOS artifacts and
  checksums while preserving the stable Windows download URLs.
- [ ] Configure Apple signing, hardened runtime, entitlements, and notarization
  before advertising the macOS package as suitable for general installation.
- [ ] Update `README.md`, `AGENTS.md`, and this file with tested installation,
  security-warning, and troubleshooting guidance.

## Distribution hardening

- [ ] Configure Windows code signing in GitHub Actions when a suitable
  certificate and protected repository secrets are available.
- [ ] Verify signatures on both the NSIS installer and portable executable, then
  remove the unsigned-package warning only after a public release is confirmed
  signed.

## Product and test polish

- [ ] Replace the functional project/file icons with final original branding
  and verify them in installed shortcuts and `.excalidraw` associations.
- [ ] Add a packaged renderer smoke test that proves the editor and both canvas
  layers have non-zero dimensions and that no remote network request occurs.
- [ ] Add privacy-safe product screenshots to the README when suitable sample
  drawings and final branding are available.
- [ ] Gather public feedback before expanding property-level merge behavior,
  Linux packaging, ARM64 packaging beyond the selected macOS target, or
  automatic updates.
