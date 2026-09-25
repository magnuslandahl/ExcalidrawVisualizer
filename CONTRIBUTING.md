# Contributing

Issues and pull requests are welcome.

## Development

```powershell
npm ci
npm run dev
```

Before opening a pull request:

```powershell
npm run check
npm run build
```

Changes to Electron runtime behavior or packaging should also pass:

```powershell
npm run package:dir
```

## Public repository safety

Everything in this repository is public. Do not commit credentials, internal
URLs, private drawings, screenshots containing private information, local
absolute paths, logs, generated installers, or application state.

Review the staged diff manually and run:

```powershell
gitleaks git --staged --no-banner
```

See [AGENTS.md](AGENTS.md) for the full safety and architecture briefing.

## Pull requests

Keep changes focused and preserve the existing security boundary. Pull requests
must pass the aggregate `CI` check before merge.

Use conventional, descriptive commit subjects. Explain behavior changes and
include tests that would have caught regressions.

## Releases

`main` publishes the rolling `latest` release. Permanent releases use semantic
version tags that match `package.json`:

```powershell
npm version patch --no-git-tag-version
npm run release:check-version -- v0.1.1
git tag v0.1.1
git push origin v0.1.1
```

Packages are currently unsigned, so release notes must retain the Windows
SmartScreen warning.
