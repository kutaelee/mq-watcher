# Broker-generated KahaDB validation

Validation date: 2026-08-14

MQ Watcher starts an embedded Apache ActiveMQ Classic broker with a persistent
KahaDB adapter and a loopback-only ephemeral connector. The producer creates:

- a pending persistent message on Queue `ORDERS`;
- a persistent message on Queue `ACK.TEST`, followed by a client ACK;
- a persistent message on Queue `PAYMENTS` inside a committed local transaction;
- durable subscription `fixture-durable-client:prices-sub` on Topic `PRICES`,
  followed by a persistent message while the subscriber is offline.

The broker is cleanly stopped before the Store is scanned. The verifier requires
valid KahaDB batch checksums, the matching add/remove message ID for the ACK,
the matching transaction ID for add/commit, the durable subscription record,
deterministic repeated results, and identical before/after source hashes.

| ActiveMQ | Java | Official `activemq-all` SHA-256 | Committed `db-1.log` SHA-256 | Result |
| --- | --- | --- | --- | --- |
| 5.13.5 | 8 | `a7883010b8b0a27abe0275dd8701cbabb6ca532da2609e275f72ef241486284f` | `bc50e738fc992d9254063447e79d04523945b85b8561eeccdfeaed41cb9d19bf` | 10 batches, 10 records, PASS |
| 5.15.16 | 8 | `211e6b65d0b4ee636e29bfaeff20f3e6e519afe59a3f85b845166c33ea09eeec` | `632bc8b552493e6efb450aa977de0f05cc3e6e0e363ef9e924d6611567c1f2cd` | 10 batches, 10 records, PASS |
| 5.18.7 | 17 | `de4485b435c1ab316451a5b82f20d384cf74a1ff0e78448321da2649183c8774` | `545fa8ced233ed45a05bdde118107bb72caecd038caf9b06b035ae62386e8b8f` | 10 batches, 10 records, PASS |

The exact artifact URLs, SHA-1/SHA-256 values, runtime dependencies, broker
configuration, and every fixture file hash are recorded in each committed
`manifest.json`. CI independently regenerates all three stores from the pinned
Maven Central artifacts and runs the same verifier against the fresh output.

This establishes compatibility for the listed scenarios and selected journal
metadata. It does not certify OpenWire body decoding, `db.data` page indexes,
recovery, corruption repair, or every ActiveMQ release.
