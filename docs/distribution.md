# Distribution and local CLI

## Quick run

After an npm release is explicitly approved and published:

```bash
npx mq-watcher
```

The CLI binds only to `127.0.0.1` and uses the stable default URL `http://127.0.0.1:38921`. Keeping the origin stable lets browser IndexedDB restore open Store sessions, cached analysis, language, and UI state after the process restarts. To request a different loopback port:

```bash
npx mq-watcher --port 3000
```

Use `--port 0` only when an ephemeral port is intentional, such as an isolated smoke test. Browser storage is scoped to the exact origin, so a custom port has a separate local workspace.

Until a package is published, use a source checkout:

```bash
npm ci
npm run build
node bin/mq-watcher.mjs
```

The HTTP process serves only the packaged UI and its browser worker modules. Store selection and scanning remain inside the browser through read-only file handles; the CLI does not add an upload endpoint, broker connection, recovery operation, or writable store handle.

## Package state

The package includes metadata, a `mq-watcher` bin entry, runtime dependencies, a build-time `prepack` check, and an explicit file allowlist. `npm pack --dry-run` validates that only the CLI, built application, README, license, and package metadata are shipped. The npm name returned `404 Not Found` when checked on 2026-08-14, but a name is not reserved until publication.

No npm publication is performed by repository tests or CI. Publishing requires separate user approval and credentials.

## Platform verification

| Platform | Runtime | Status |
| --- | --- | --- |
| Windows 11 x64 | Node 24.18.0, npm 11.16.0 | Locally verified: clean install, build, tests, fixture tests, CLI HTTP smoke, package dry-run |
| Windows latest runner | Node 22.13.0 | CI configured; not locally verified |
| Ubuntu latest runner | Node 22.13.0 | CI configured; not locally verified |

The CI matrix must pass before a release is described as verified on its two hosted platforms.
