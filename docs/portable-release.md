# Portable release and updater

MQ Watcher portable executables are built with Node.js Single Executable Applications. They embed the production server/client build and the React runtime packages reported as external by the production build.

## Startup and cache boundary

At startup the executable:

1. reads the embedded application manifest;
2. validates manifest structure, schema version, paths, sizes, and every embedded asset SHA-256;
3. extracts application assets to a version-and-manifest-hash-specific cache directory;
4. publishes the cache under a lock and verifies an existing cache before reuse;
5. quarantines and recreates a corrupt or incomplete cache instead of trusting it;
6. imports the extracted production server;
7. binds an HTTP listener explicitly to `127.0.0.1` on an available port;
8. opens the default browser unless `--no-open` is supplied.

Cache locations:

- Windows: `%LOCALAPPDATA%\MQ Watcher\Cache\<version-hash>`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/mq-watcher/<version-hash>`

The cache contains packaged application code and static assets only. Selected ActiveMQ Store files remain behind browser read-only handles and are not copied to the application cache. Different application versions use isolated cache keys, so an upgrade or downgrade does not reinterpret an older cache directory as the current package.

## Update behavior

When the UI opens, the local server requests metadata only from the fixed latest-release endpoint for this repository. The request identifies the MQ Watcher version in its user agent. It does not include selected Store paths, Store names, source bytes, cached analysis, incident notes, or exported evidence.

Release assets are downloaded only after the user clicks **Verify and update**. The in-place replacement path is enabled only for the Windows x64 portable executable. Source, npm, Linux, unsupported architecture, draft, pre-release, downgrade, and incomplete-asset cases do not perform automatic replacement.

The supported Windows replacement flow:

1. accepts the install request only from the same loopback UI instance using its random per-process token and same-origin browser metadata;
2. repeats the release check instead of trusting browser-supplied asset data;
3. accepts the documented GitHub release page, release asset paths, and approved HTTPS download hosts only;
4. rejects unexpected final redirects, invalid or mismatched declared sizes, oversized responses, and malformed metadata;
5. downloads the portable executable and `SHA256SUMS.txt` to task-owned staging beside the current executable;
6. verifies the checksum file, release asset digest when supplied, received byte count, and staged SHA-256;
7. launches a narrowly scoped replacement helper, verifies the staged checksum again, swaps the executable, and smoke-checks the expected version;
8. restarts the verified new executable, or restores and restarts the previous executable when the replacement/version check fails;
9. removes task-owned staged, helper, and backup files on success, cancellation, or handled failure.

This is a supply-chain boundary, not code signing. Windows binaries are currently unsigned, so users should verify `SHA256SUMS.txt` and may still see a Windows SmartScreen warning. A compromised repository release or GitHub account is outside the guarantee provided by checksum verification against metadata from the same release channel.

## Release smoke tests

Release CI starts each newly built executable with `--no-open --port 0`, waits for the printed loopback URL, requests `/`, requires HTTP 200 and the expected HTML title, and terminates the exact child process. Only after that check does CI create the ZIP/tar archive and `SHA256SUMS.txt`.

Portable cache tests cover fail-closed manifest validation, corrupt-cache self-healing, isolated v0.2/v0.3 cache keys, and concurrent cold extraction. Updater tests cover strict version selection, same-origin authorization, redirect/size/hash failures, cancellation cleanup, successful Windows replacement, rollback and restart, and post-staging tamper rejection using command fixtures.

The final v0.3 release gate additionally requires a real v0.2 executable → real v0.3 executable → real v0.2 executable smoke test and tag-triggered CI. Until those are recorded as complete in [v0.3 validation](validation/v0.3-investigation-workbench.md), this document does not claim the v0.3 release has passed.
