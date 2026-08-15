# Message Trace validation

The Message Trace gate verifies exact identity, conservative interpretation, Store isolation, export redaction, and source safety.

## Synthetic scenarios

- Normal lifecycle: one ADD and one ACK/remove.
- Repeated ADD: two ADD observations without a duplicate-delivery verdict.
- Transaction: ADD associated with a transaction and a matching commit record.
- No ACK: no ACK/remove observation without a “never acknowledged” claim.
- Two snapshots: each Store retains an independent result.
- Similar IDs: `ID:ABC:1` does not match `ID:ABC:10` or a case variant.

`tests/message-trace.test.mjs` also verifies that the scanner can extend the initial 2,500 message candidates to the actual end of a synthetic Store, that Incident Cases reject foreign-Store pins, and that a 10,000-record exact trace remains within a five-second regression budget. The current local targeted run completed that trace in about 2 ms; this is regression evidence on the test workstation, not a universal performance claim.

The browser E2E keeps one unresolved semantic reference in a case owned by the same Store. This preserves the reload/unresolved-reference workflow without allowing evidence from a different Store to appear in the active Store's case.

## Required release gate

Run lint, typecheck, build, the complete test suite, synthetic and broker fixtures, IndexedDB migration E2E, portable cache tests, audit, and package dry-run. If portable code changes, rebuild and smoke-test the executable. Broker-generated fixture validation must continue to preserve the source SHA before and after scanning.

## Local v0.4.0 release-candidate result

Verified on 2026-08-15 with Node.js 22.13.0:

- lint and strict type checking: PASS
- production build and complete test suite: 88/88 PASS
- deterministic fixture tests: 15/15 PASS
- broker-generated fixture/privacy tests: 4/4 PASS for ActiveMQ Classic 5.13.5, 5.15.16, and 5.18.7
- portable cache tests: 6/6 PASS
- real Chrome IndexedDB/usability E2E: 22 assertions PASS, with browser, server, and temporary profile cleanup confirmed
- the browser E2E covers direct page entry by both Go and Enter, a comparison-only ID entering an all-Store trace, trace evidence being pinned in its owning Store case, and invalid export Trace input being rejected visibly
- production dependency audit: 0 vulnerabilities
- package dry-run: 81 files, 683.9 kB packed
- Windows x64 portable smoke: HTTP 200 and expected title, stable `127.0.0.1:38921` restart, two concurrent cold launches, marker/asset/extra-file self-heal, and cleanup PASS

The final local executable is rebuilt after the release-candidate source is frozen. Its exact SHA-256 is recorded in the release gate evidence and must not be reused for a later source revision. This document does not claim that v0.4.0 is publicly released: PR CI, merged-main CI, tag workflow, release assets, and published checksums remain separate external gates.
