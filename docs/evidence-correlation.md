# Evidence correlation

Correlation connects facts already present in scanner output. It does not determine why a broker or client failed.

## Relationships

- A structured `KAHA_ADD_MESSAGE_COMMAND` becomes a message link with its destination, journal file, record location, optional transaction, and evidence references.
- A `KAHA_REMOVE_MESSAGE_COMMAND` with the same message ID and destination is reported as observed ACK/remove evidence.
- A `KAHA_SUBSCRIPTION_COMMAND` links its subscription key to the destination decoded from the same record.
- Records sharing a parsed transaction ID are grouped; a commit or rollback is reported only when that command is present in the scanned records.
- A structured add targeting a destination containing `.Advisory.` becomes an Advisory link. Printable-string Advisory candidates remain separately identified as non-structured evidence.

Every link carries references to the source file, parsed record ID and offset, and nearby raw strings when available. The UI can follow these references to the file, structured record, raw string, or original heuristic candidate.

## Interpretation boundary

`ACK record observed` means a matching remove command exists in the scanned journal records. `ACK record not observed` means only that the bounded input did not contain a matching decoded command. It does not prove that the message was never acknowledged, that the store is corrupt, or that any client caused an outage.

Likewise, an absent commit/rollback record is not proof of an incomplete transaction. Results can be incomplete because the selected directory, retained journal range, parser support, or safety limits are incomplete.
