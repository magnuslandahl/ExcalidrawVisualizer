# Project TODO

This file is the handoff queue for unfinished Excalidraw Visualizer work. Read
`AGENTS.md` before starting an item, keep this list current as work progresses,
and do not mark a platform supported until its packaged application has been
tested on that platform.

The first public Windows release is version `0.1.0`. Windows x64 and macOS 13+
on Apple silicon and Intel are now packaged and advertised. The permanent
`v0.1.0` release predates macOS packaging; macOS downloads begin with the next
rolling and tagged releases.

## macOS support

macOS packaging is implemented. Electron 44 sets the baseline at macOS 13
Ventura. Releases build separate Apple silicon (`arm64`) and Intel (`x64`) disk
images.

- [x] Document macOS 13+ with both Apple silicon and Intel in scope.
- [x] Verify `npm ci`, `npm run check`, and `npm run build` on an Apple-silicon
  Mac.
- [x] Add electron-builder macOS targets, application/document icons, native
  menu roles, and `.excalidraw` association without weakening Windows targets.
- [x] Exercise a packaged Apple-silicon application with the sandboxed CommonJS
  preload, launch-path opening, non-zero Excalidraw canvas layers, atomic
  external replacement, application-originated atomic save, local assets, and
  zero remote renderer requests. Shared automated tests continue to cover
  watcher recovery and conflict behavior.
- [x] Add both-architecture macOS packaging and native packaged-runtime smoke
  coverage to GitHub Actions.
- [x] Extend rolling and tagged releases with stable, clearly named macOS
  artifacts and shared checksums while preserving Windows download URLs.
- [x] Include Gatekeeper, damaged-app, architecture, and minimum-version
  guidance in each DMG and in public documentation.
- [ ] Configure Apple Developer ID signing, hardened runtime, entitlements,
  notarization, and stapling. Ad-hoc signatures make the current bundles
  internally runnable but do not remove Gatekeeper warnings.

## Distribution hardening

- [ ] Configure Windows code signing in GitHub Actions when a suitable
  certificate and protected repository secrets are available.
- [ ] Verify signatures on both the NSIS installer and portable executable, then
  remove the unsigned-package warning only after a public release is confirmed
  signed.
- [ ] Configure Apple Developer ID signing and notarization credentials in
  GitHub Actions, verify both architecture-specific DMGs with `codesign`,
  `spctl`, and `stapler`, then remove the Gatekeeper instructions only after a
  public release is confirmed notarized.

## Product and test polish

- [ ] Replace the functional project/file icons with final original branding
  and verify them in installed shortcuts and `.excalidraw` associations.
- [x] Add a packaged renderer smoke test that proves the editor and both canvas
  layers have non-zero dimensions and that no remote network request occurs.
- [ ] Add privacy-safe product screenshots to the README when suitable sample
  drawings and final branding are available.
- [ ] Gather public feedback before expanding property-level merge behavior,
  Linux packaging, ARM64 packaging beyond the selected macOS target, or
  automatic updates.
