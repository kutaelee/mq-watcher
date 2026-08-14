# Portable release

The portable executable is built with Node.js Single Executable Applications.
It embeds the production server/client build plus the React runtime packages
reported as external by the production build.

At startup the executable:

1. reads the embedded application manifest;
2. verifies every embedded asset SHA-256;
3. extracts application assets to a version-and-hash-specific cache directory;
4. verifies an existing cache before reuse;
5. imports the extracted production server;
6. binds an HTTP listener explicitly to `127.0.0.1` on an available port;
7. opens the default browser unless `--no-open` is supplied.

Cache locations:

- Windows: `%LOCALAPPDATA%\MQ Watcher\Cache\<version-hash>`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/mq-watcher/<version-hash>`

The cache contains packaged application code and static assets only. Selected
ActiveMQ Store files remain under browser read-only handles and are not copied
to the application cache. The executable has no telemetry or update client.

Release CI runs the executable with `--no-open --port 0`, waits for the printed
loopback URL, requests `/`, requires HTTP 200 and the expected HTML title, and
then terminates the exact child process. Only after that smoke test does CI
create the ZIP/tar archive and `SHA256SUMS.txt`.

Windows binaries are currently unsigned. Users should verify the archive hash
and may still see a Windows SmartScreen warning.
