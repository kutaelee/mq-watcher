# Contributing to MQ Watcher

## Setup

```bash
git clone https://github.com/kutaelee/mq-watcher.git
cd mq-watcher
npm ci
npm run dev
```

Node.js 22.13 or newer is required.

## Required validation

Before opening a pull request, run:

```bash
npm run lint
npm run build
npm test
npm run test:fixtures
```

Describe the tested platform and any tests that were not run. Never report an unexecuted check as passing.

## Adding a fixture

1. Prefer a minimal synthetic fixture that contains no customer, production, personal, credential, or proprietary data.
2. Document whether it is synthetic or broker-generated, how it was produced, the relevant license, version, and checksums.
3. Add a normalized golden result under `fixtures/expected/`.
4. Scan it at least twice and verify deterministic output and identical before/after SHA-256 values.
5. Add malformed, truncated, false-positive, and bounded-result cases when they apply.

Synthetic conformance bytes may test a documented format but must not be called runtime compatibility proof. Do not start a broker merely to satisfy a fixture test in this repository.

## Adding or extending a parser

1. Identify the exact official ActiveMQ class, schema, tag, and byte rule first.
2. Document the supported and unsupported boundary.
3. Keep structured parsing separate from heuristic string evidence.
4. Return `Unknown`, `Unsupported`, or `Partial` on missing, version-mismatched, truncated, or malformed input.
5. Bound memory, record counts, previews, and loops.
6. Add unit tests, fixture comparison, corruption cases, and regression coverage.

Do not hardcode output to a fixture and do not describe an arbitrary binary format as KahaDB.

## Confidence semantics

- `Parsed`: decoded by a documented format rule within the declared support boundary.
- `Observed`: directly present in a source file without full semantic interpretation.
- `Pattern Match`: matched a string or proximity rule and requires confirmation.
- `Unknown`: insufficient evidence.

`Inference` should be exceptional, clearly labeled, and never used to invent a missing fact.

## Read-only invariant

Parser and UI changes must not add broker startup or connection, store recovery, compaction, mutation, rename, deletion, upload, or writable store handles. New local HTTP routes must be reviewed for accidental data transmission. Source hashes must remain unchanged across scans.

## Pull request checklist

- [ ] Scope and evidence source are documented.
- [ ] No secrets, customer data, local absolute paths, or proprietary names are included.
- [ ] Confidence labels match the evidence type.
- [ ] Failure behavior preserves unknowns.
- [ ] Read-only and bounded-processing tests pass.
- [ ] Lint, build, full tests, and fixture tests pass.
- [ ] Documentation and screenshots use only public synthetic data.
