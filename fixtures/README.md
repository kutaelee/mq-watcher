# MQ Watcher fixtures

The files under `synthetic/` are deliberately small regression inputs for the
read-only evidence scanner.

> **Synthetic fixture != real ActiveMQ-generated store.**

They exercise filenames, printable strings, malformed bytes, truncation, and
scanner limits. They must not be cited as proof that MQ Watcher parses a real
KahaDB journal. Real, redistributable ActiveMQ fixtures may be added later under
`activemq/<version>/` with their generator version, commands, license, and
checksums documented beside them.

`expected/` contains deterministic, reviewed scanner output. Volatile fields
such as scan time, file mtime, and directory signature are intentionally
excluded from the golden comparison.

Generate the committed synthetic byte fixtures with:

```bash
npm run fixtures:generate
```

Validate all fixtures and the source hash invariant with:

```bash
npm run test:fixtures
```

Fixture rules:

- no customer, production, personal, or credential data;
- no broker startup or broker connection;
- no store recovery, compaction, rename, delete, or write during scanning;
- changes to a golden result require review of both the fixture bytes and the
  scanner behavior.
