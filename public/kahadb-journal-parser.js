/*
 * Read-only KahaDB journal framing parser.
 *
 * Format rules are derived from Apache ActiveMQ Classic's Journal,
 * DataFileAppender, DataFileAccessor, MessageDatabase and journal-data.proto.
 * It parses journal batches, record headers and the documented KahaDB command
 * envelope. OpenWire message bodies and page-file indexes are intentionally out
 * of scope.
 */

const RECORD_HEAD_SPACE = 5;
const USER_RECORD_TYPE = 1;
const BATCH_CONTROL_RECORD_TYPE = 2;
const BATCH_MAGIC = new TextEncoder().encode("WRITE BATCH");
const BATCH_CONTROL_RECORD_SIZE = RECORD_HEAD_SPACE + BATCH_MAGIC.length + 4 + 8;
const EOF_RECORD = Uint8Array.from([0x2d, 0x71, 0x4d, 0x61, 0x34]);
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_BATCHES = 10_000;
const MAX_RECORDS = 50_000;

const COMMAND_NAMES = [
  "KAHA_TRACE_COMMAND",
  "KAHA_ADD_MESSAGE_COMMAND",
  "KAHA_REMOVE_MESSAGE_COMMAND",
  "KAHA_PREPARE_COMMAND",
  "KAHA_COMMIT_COMMAND",
  "KAHA_ROLLBACK_COMMAND",
  "KAHA_REMOVE_DESTINATION_COMMAND",
  "KAHA_SUBSCRIPTION_COMMAND",
  "KAHA_PRODUCER_AUDIT_COMMAND",
  "KAHA_ACK_MESSAGE_FILE_MAP_COMMAND",
  "KAHA_UPDATE_MESSAGE_COMMAND",
  "KAHA_ADD_SCHEDULED_JOB_COMMAND",
  "KAHA_RESCHEDULE_JOB_COMMAND",
  "KAHA_REMOVE_SCHEDULED_JOB_COMMAND",
  "KAHA_REMOVE_SCHEDULED_JOBS_COMMAND",
  "KAHA_DESTROY_SCHEDULER_COMMAND",
  "KAHA_REWRITTEN_DATA_FILE_COMMAND",
];

function bytesEqual(left, right, offset = 0) {
  if (offset + right.length > left.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    if (left[offset + index] !== right[index]) return false;
  }
  return true;
}

function readInt32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, false);
}

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint64(bytes, offset) {
  return (BigInt(readUint32(bytes, offset)) << 32n) | BigInt(readUint32(bytes, offset + 4));
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  const modulo = 65521;
  for (let offset = 0; offset < bytes.length; offset += 5_552) {
    const end = Math.min(bytes.length, offset + 5_552);
    for (let index = offset; index < end; index += 1) {
      a += bytes[index];
      b += a;
    }
    a %= modulo;
    b %= modulo;
  }
  return ((b << 16) | a) >>> 0;
}

function readVarint(bytes, start, end = bytes.length) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < end && offset - start < 10) {
    const byte = bytes[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error(offset >= end ? "Truncated varint" : "Malformed varint");
}

function parseProtoFields(bytes) {
  const fields = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber === 0) throw new Error("Invalid protobuf field number 0");
    let value;
    if (wireType === 0) {
      const decoded = readVarint(bytes, offset);
      value = decoded.value;
      offset = decoded.offset;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new Error("Truncated fixed64 field");
      value = bytes.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      if (length.value > BigInt(bytes.length - offset)) throw new Error("Truncated length-delimited field");
      const end = offset + Number(length.value);
      value = bytes.subarray(offset, end);
      offset = end;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new Error("Truncated fixed32 field");
      value = bytes.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
    const values = fields.get(fieldNumber) || [];
    values.push({ wireType, value });
    fields.set(fieldNumber, values);
  }
  return fields;
}

function firstField(fields, number, wireType) {
  return fields.get(number)?.find((field) => field.wireType === wireType)?.value;
}

function decodeText(value) {
  if (!(value instanceof Uint8Array)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function parseDestination(value) {
  if (!(value instanceof Uint8Array)) return undefined;
  const fields = parseProtoFields(value);
  const typeValue = firstField(fields, 1, 0);
  const name = decodeText(firstField(fields, 2, 2));
  if (typeValue === undefined || !name) return undefined;
  const types = ["Queue", "Topic", "Temporary Queue", "Temporary Topic"];
  const type = types[Number(typeValue)] || "Unknown";
  return { type, name };
}

function parseTransaction(value) {
  if (!(value instanceof Uint8Array)) return undefined;
  const fields = parseProtoFields(value);
  const local = firstField(fields, 1, 2);
  if (local instanceof Uint8Array) {
    const localFields = parseProtoFields(local);
    const connectionId = decodeText(firstField(localFields, 1, 2));
    // ActiveMQ Classic's generated KahaLocalTransactionId schema uses field 1
    // for both connection_id (wire type 2) and transaction_id (wire type 0).
    // Accept field 2 as well for stores produced by corrected/custom schemas.
    const transactionId = firstField(localFields, 1, 0) ?? firstField(localFields, 2, 0);
    if (connectionId && transactionId !== undefined) {
      return `local:${connectionId}:${transactionId.toString()}`;
    }
  }
  const xa = firstField(fields, 2, 2);
  if (xa instanceof Uint8Array) {
    const xaFields = parseProtoFields(xa);
    const formatId = firstField(xaFields, 1, 0);
    if (formatId !== undefined) return `xa:${formatId.toString()}`;
  }
  return undefined;
}

function parseCommandPayload(commandType, payload) {
  const command = COMMAND_NAMES[commandType];
  if (!command) {
    return { command: `UNKNOWN_COMMAND_${commandType}`, status: "Unsupported" };
  }
  const fields = parseProtoFields(payload);
  const result = { command, status: "Parsed" };

  if (commandType === 1 || commandType === 2) {
    result.transactionId = parseTransaction(firstField(fields, 1, 2));
    result.destination = parseDestination(firstField(fields, 2, 2));
    result.messageId = decodeText(firstField(fields, 3, 2));
    if (commandType === 2) result.subscriptionKey = decodeText(firstField(fields, 5, 2));
    if (!result.destination || !result.messageId) result.status = "Partial";
  } else if (commandType >= 3 && commandType <= 5) {
    result.transactionId = parseTransaction(firstField(fields, 1, 2));
    if (!result.transactionId) result.status = "Partial";
  } else if (commandType === 6) {
    result.destination = parseDestination(firstField(fields, 1, 2));
    if (!result.destination) result.status = "Partial";
  } else if (commandType === 7) {
    result.destination = parseDestination(firstField(fields, 1, 2));
    result.subscriptionKey = decodeText(firstField(fields, 2, 2));
    if (!result.destination || !result.subscriptionKey) result.status = "Partial";
  } else {
    result.status = "Partial";
  }
  return result;
}

function parseRecord(data, file, fileId, offset, size, type) {
  const base = {
    file,
    location: { dataFileId: fileId, offset, size },
    recordType: type,
    confidence: "Parsed",
  };
  if (type !== USER_RECORD_TYPE) {
    return { ...base, status: "Unsupported", command: "Unknown" };
  }
  if (data.length < 2) {
    return { ...base, status: "Partial", command: "Unknown", warning: "Record payload is truncated." };
  }
  const commandType = data[0];
  try {
    const frame = readVarint(data, 1);
    const frameLength = Number(frame.value);
    if (!Number.isSafeInteger(frameLength) || frameLength > data.length - frame.offset) {
      throw new Error("Command frame exceeds the record boundary");
    }
    if (frame.offset + frameLength !== data.length) {
      throw new Error("Command frame does not consume the record payload");
    }
    return {
      ...base,
      commandType,
      ...parseCommandPayload(commandType, data.subarray(frame.offset, frame.offset + frameLength)),
    };
  } catch (error) {
    return {
      ...base,
      commandType,
      command: COMMAND_NAMES[commandType] || `UNKNOWN_COMMAND_${commandType}`,
      status: "Partial",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readRange(file, start, length) {
  const end = Math.min(file.size, start + length);
  if (start >= end) return new Uint8Array();
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function batchHeaderMatches(header) {
  return header.length >= BATCH_CONTROL_RECORD_SIZE
    && readInt32(header, 0) === BATCH_CONTROL_RECORD_SIZE
    && header[4] === BATCH_CONTROL_RECORD_TYPE
    && bytesEqual(header, BATCH_MAGIC, RECORD_HEAD_SPACE);
}

function isZeroFilled(bytes) {
  return bytes.length > 0 && bytes.every((byte) => byte === 0);
}

export async function parseKahaDbJournalFile(file, relativePath) {
  const fileMatch = relativePath.match(/(?:^|\/)db-(\d+)\.log$/i);
  const fileId = fileMatch ? Number(fileMatch[1]) : null;
  const output = {
    file: relativePath,
    fileId,
    format: "Apache ActiveMQ Classic KahaDB journal framing",
    status: "Unknown",
    confidence: "Unknown",
    batches: [],
    records: [],
    warnings: [],
    truncated: false,
  };
  if (fileId === null) {
    output.status = "Unsupported";
    output.warnings.push("The file name does not identify a KahaDB db-<id>.log journal.");
    return output;
  }

  let offset = 0;
  while (offset < file.size && output.batches.length < MAX_BATCHES && output.records.length < MAX_RECORDS) {
    const header = await readRange(file, offset, BATCH_CONTROL_RECORD_SIZE);
    if (header.length >= EOF_RECORD.length && bytesEqual(header, EOF_RECORD)) break;
    // A preallocated KahaDB journal normally has a zero-filled unused tail.
    if (isZeroFilled(header)) break;
    if (!batchHeaderMatches(header)) {
      output.warnings.push(`No valid KahaDB batch header at offset ${offset}.`);
      break;
    }

    const payloadSize = readInt32(header, RECORD_HEAD_SPACE + BATCH_MAGIC.length);
    const expectedChecksum = readUint64(header, RECORD_HEAD_SPACE + BATCH_MAGIC.length + 4);
    if (payloadSize < 0 || payloadSize > MAX_BATCH_BYTES) {
      output.status = "Unsupported";
      output.confidence = "Parsed";
      output.warnings.push(`Batch at offset ${offset} declares unsupported size ${payloadSize}.`);
      break;
    }
    const body = await readRange(file, offset + BATCH_CONTROL_RECORD_SIZE, payloadSize);
    if (body.length !== payloadSize) {
      output.status = "Partial";
      output.confidence = "Parsed";
      output.warnings.push(`Batch at offset ${offset} is truncated.`);
      break;
    }

    const actualChecksum = BigInt(adler32(body));
    const checksum = expectedChecksum === 0n
      ? "Not present"
      : expectedChecksum === actualChecksum ? "Valid" : "Invalid";
    const batch = {
      offset,
      payloadSize,
      expectedChecksum: expectedChecksum.toString(),
      actualChecksum: actualChecksum.toString(),
      checksum,
      status: checksum === "Invalid" ? "Partial" : "Parsed",
      confidence: "Parsed",
    };
    output.batches.push(batch);
    output.status = batch.status === "Partial" ? "Partial" : output.status === "Unknown" ? "Parsed" : output.status;
    output.confidence = "Parsed";

    let recordOffset = 0;
    while (recordOffset < body.length && output.records.length < MAX_RECORDS) {
      if (body.length - recordOffset < RECORD_HEAD_SPACE) {
        output.status = "Partial";
        output.warnings.push(`Record header is truncated in batch at offset ${offset}.`);
        break;
      }
      const recordSize = readInt32(body, recordOffset);
      const recordType = body[recordOffset + 4];
      if (recordSize < RECORD_HEAD_SPACE || recordSize > body.length - recordOffset) {
        output.status = "Partial";
        output.warnings.push(`Invalid record size ${recordSize} in batch at offset ${offset}.`);
        break;
      }
      const absoluteRecordOffset = offset + BATCH_CONTROL_RECORD_SIZE + recordOffset;
      const record = parseRecord(
        body.subarray(recordOffset + RECORD_HEAD_SPACE, recordOffset + recordSize),
        relativePath,
        fileId,
        absoluteRecordOffset,
        recordSize,
        recordType,
      );
      output.records.push(record);
      if (record.status !== "Parsed" && output.status === "Parsed") output.status = "Partial";
      recordOffset += recordSize;
    }
    offset += BATCH_CONTROL_RECORD_SIZE + payloadSize;
  }

  if (output.batches.length >= MAX_BATCHES || output.records.length >= MAX_RECORDS) {
    output.truncated = true;
    output.warnings.push("Structured results reached the configured safety limit.");
  }
  return output;
}

export function summarizeStructuredJournals(journals) {
  const records = journals.flatMap((journal) => journal.records);
  const parsedCount = journals.filter((journal) => journal.status === "Parsed").length;
  const partialCount = journals.filter((journal) => journal.status === "Partial").length;
  return {
    parser: "KahaDB journal framing and command envelope",
    scope: "Batch framing, record headers, KahaDB command type and selected protobuf metadata; OpenWire bodies and page indexes are unsupported.",
    status: partialCount > 0 ? "Partial" : parsedCount > 0 ? "Parsed" : "Unknown",
    confidence: parsedCount > 0 || partialCount > 0 ? "Parsed" : "Unknown",
    journals,
    records,
    warnings: journals.flatMap((journal) => journal.warnings.map((warning) => `${journal.file}: ${warning}`)),
    truncated: journals.some((journal) => journal.truncated),
  };
}
