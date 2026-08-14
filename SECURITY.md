# Security and privacy

## Local data handling

MQ Watcher is designed for local, read-only examination. The CLI binds to `127.0.0.1`; the browser requests read-only directory handles and scans files in a Worker. The application has no store-upload endpoint and does not connect to a broker or external analysis service.

Review dependency behavior and your network controls before using any open-source tool with sensitive evidence. A browser extension, modified build, reverse proxy, or separately installed software is outside this repository's guarantees.

## Browser storage and IndexedDB

Scan results can be cached in IndexedDB to avoid repeating work. Cached results can contain destination names, message or consumer IDs, filenames, offsets, raw printable strings, and bounded HEX previews. Original store file contents are not copied wholesale into IndexedDB, but the cached evidence can still be operationally sensitive.

Use a dedicated browser profile or controlled workstation when appropriate. Clear the site's storage in browser settings to remove its IndexedDB cache. Removing the cache does not change the source store.

## Screenshots and exports

Screenshots, copied values, console output, and any future exports may reveal identifiers or message-adjacent text. Review and redact them before sharing. Repository screenshots must use only committed public synthetic fixtures.

## Vulnerability reporting

For a security vulnerability, use the repository's **Security → Report a vulnerability** flow when available. Do not include sensitive store samples, credentials, or exploit details in a public issue. If private reporting is unavailable, open a minimal public issue requesting a private contact channel without disclosing the vulnerability.

Useful reports include the affected version/commit, platform, reproduction steps using synthetic data, impact, and a proposed mitigation if known.

## Supported versions

Security fixes are applied to the current default branch. Until tagged releases and an explicit support policy exist, older commits are not guaranteed to receive backports.
