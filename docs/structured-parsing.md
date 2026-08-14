# Structured KahaDB parsing boundary

MQ Watcher keeps raw printable-string evidence separate from structured results. A value receives `Parsed` confidence only when the byte sequence satisfies the format rules described below. A filename, printable string, or regular-expression match is not promoted into a structured record.

## Source basis

The implementation follows these Apache ActiveMQ Classic sources:

- [`Journal`](https://github.com/apache/activemq/blob/main/activemq-kahadb-store/src/main/java/org/apache/activemq/store/kahadb/disk/journal/Journal.java): `db-<id>.log` naming, 5-byte record header, `WRITE BATCH` control record, batch size, Adler-32 checksum, and EOF marker.
- [`DataFileAppender`](https://github.com/apache/activemq/blob/main/activemq-kahadb-store/src/main/java/org/apache/activemq/store/kahadb/disk/journal/DataFileAppender.java): batch layout and the sequence of record size, record type, and record payload.
- [`DataFileAccessor`](https://github.com/apache/activemq/blob/main/activemq-kahadb-store/src/main/java/org/apache/activemq/store/kahadb/disk/journal/DataFileAccessor.java): location offset, size, type, and payload boundaries.
- [`MessageDatabase`](https://github.com/apache/activemq/blob/main/activemq-kahadb-store/src/main/java/org/apache/activemq/store/kahadb/MessageDatabase.java): one-byte KahaDB command type followed by a framed command message.
- [`journal-data.proto`](https://github.com/apache/activemq/blob/main/activemq-kahadb-store/src/main/proto/journal-data.proto): command identifiers and fields for destinations, message IDs, subscriptions, and transactions.
- [`BaseMessage`](https://github.com/apache/activemq-protobuf/blob/master/activemq-protobuf/src/main/java/org/apache/activemq/protobuf/BaseMessage.java): the command frame begins with a protobuf varint payload length.

The same journal constants and command schema were source-reviewed in the official `activemq-5.15.16` and `activemq-5.18.7` tags. This is a source-layout comparison, not runtime compatibility certification. Apache documents that KahaDB is the default store from ActiveMQ 5.4 and that `storeOpenWireVersion` varies across releases; MQ Watcher therefore does not infer a broker or OpenWire version from journal framing alone. See the official [KahaDB documentation](https://activemq.apache.org/components/classic/documentation/kahadb).

## Parsed in P1

- `db-<numeric-id>.log` data-file identity
- batch control header and declared payload boundary
- optional Adler-32 checksum validation
- record location: data-file ID, byte offset, size, and type
- KahaDB command IDs defined by `KahaEntryType`
- destination type/name for add, remove, subscription, and remove-destination commands
- message ID for add and remove commands
- subscription key for subscription and topic-ack records
- local/XA transaction identity where the documented fields are present

The committed `kahadb-framing` fixture is generated from these rules and checks deterministic parsing. It is a synthetic conformance fixture, not a broker-generated store.

## Explicitly unsupported or partial

- OpenWire message-body decoding and message content interpretation
- `db.data`, `db.redo`, page-file indexes, BTree state, and index recovery
- proving pending/acknowledged state from journal records alone
- legacy AMQ Message Store `journal/data-*` parsing
- automatic corruption resynchronization after an invalid header
- command-specific fields outside the selected destination/message/subscription/transaction metadata
- broker-version identification or compatibility claims without a redistributable broker-generated fixture

Unknown command IDs are `Unsupported`. Recognized framing with incomplete or malformed command fields is `Partial`. Files without a valid batch header remain `Unknown`; the parser does not manufacture fallback values.

## Safety limits

Parsing is read-only and uses `File.slice()` handles. The implementation caps a declared batch at 64 MiB, a journal at 10,000 batches, and collected structured records at 50,000. Reaching a cap sets `truncated=true` instead of consuming unbounded memory.
