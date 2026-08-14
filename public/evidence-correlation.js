/* Evidence correlation joins observed and parsed records without producing an RCA. */

function parsedRecordId(record) {
  return `parsed:${record.file}:${record.location.offset}`;
}

function parsedRef(record) {
  return {
    id: parsedRecordId(record),
    kind: "parsed-record",
    file: record.file,
    offset: record.location.offset,
    recordId: parsedRecordId(record),
    label: record.command,
    confidence: "Parsed",
  };
}

function sourceFileRef(file) {
  return {
    id: `file:${file}`,
    kind: "source-file",
    file,
    offset: null,
    label: file,
    confidence: "Observed",
  };
}

function nearbyRawRefs(record, strings) {
  return strings
    .filter((hit) => hit.file === record.file && Math.abs(hit.offset - record.location.offset) <= 8_192)
    .slice(0, 8)
    .map((hit) => ({
      id: `raw:${hit.id}`,
      kind: "raw-string",
      file: hit.file,
      offset: hit.offset,
      rawId: hit.id,
      label: hit.value,
      confidence: "Observed",
    }));
}

function sameDestination(left, right) {
  return left?.type === right?.type && left?.name === right?.name;
}

function uniqueRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    if (seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

export function correlateEvidence({ structured, messages, subscriptions, strings }) {
  const records = structured.records || [];
  const addRecords = records.filter((record) => record.command === "KAHA_ADD_MESSAGE_COMMAND");
  const removeRecords = records.filter((record) => record.command === "KAHA_REMOVE_MESSAGE_COMMAND");

  const messageLinks = addRecords.map((record) => {
    const ack = removeRecords.find((candidate) =>
      candidate.messageId === record.messageId && sameDestination(candidate.destination, record.destination),
    );
    const evidenceRefs = uniqueRefs([
      sourceFileRef(record.file),
      parsedRef(record),
      ...(ack ? [parsedRef(ack)] : []),
      ...nearbyRawRefs(record, strings),
      ...(ack ? nearbyRawRefs(ack, strings) : []),
    ]);
    return {
      id: `message:${record.file}:${record.location.offset}`,
      kind: "message",
      primaryId: record.messageId || "Unknown",
      destination: record.destination?.name || "Unknown",
      destinationType: record.destination?.type || "Unknown",
      journal: record.file,
      offset: record.location.offset,
      ackStatus: ack ? "Observed" : "Not observed",
      interpretation: ack
        ? "A matching remove/ack command was observed in the scanned journal evidence."
        : "A matching remove/ack command was not found in the scanned evidence. This does not prove that the message was never acknowledged.",
      interpretationCode: ack ? "ack.observed" : "ack.notObserved",
      transactionId: record.transactionId || "Unknown",
      confidence: "Parsed",
      evidenceRefs,
    };
  });

  const structuredSubscriptions = records
    .filter((record) => record.command === "KAHA_SUBSCRIPTION_COMMAND")
    .map((record) => ({
      id: `subscription:${record.file}:${record.location.offset}`,
      kind: "subscription",
      primaryId: record.subscriptionKey || "Unknown",
      destination: record.destination?.name || "Unknown",
      destinationType: record.destination?.type || "Unknown",
      journal: record.file,
      offset: record.location.offset,
      ackStatus: "Unknown",
      interpretation: "The subscription command and destination were decoded from the same structured record.",
      interpretationCode: "subscription.parsed",
      transactionId: "Unknown",
      confidence: "Parsed",
      evidenceRefs: uniqueRefs([sourceFileRef(record.file), parsedRef(record), ...nearbyRawRefs(record, strings)]),
    }));

  const heuristicSubscriptions = subscriptions.map((subscription) => ({
    id: `subscription-candidate:${subscription.id}`,
    kind: "subscription",
    primaryId: subscription.rawId,
    destination: subscription.relatedDestination,
    destinationType: "Unknown",
    journal: subscription.relatedStore,
    offset: null,
    ackStatus: "Unknown",
    interpretation: "This relation is based on nearby printable-string evidence and requires independent confirmation.",
    interpretationCode: "subscription.pattern",
    transactionId: "Unknown",
    confidence: subscription.confidence,
    evidenceRefs: [
      sourceFileRef(subscription.relatedStore),
      {
        id: `subscription-candidate:${subscription.id}`,
        kind: "subscription-candidate",
        file: subscription.relatedStore,
        offset: null,
        subscriptionId: subscription.id,
        label: subscription.rawId,
        confidence: subscription.confidence,
      },
    ],
  }));

  const transactionGroups = new Map();
  for (const record of records.filter((item) => item.transactionId)) {
    const group = transactionGroups.get(record.transactionId) || [];
    group.push(record);
    transactionGroups.set(record.transactionId, group);
  }
  const transactionLinks = Array.from(transactionGroups, ([transactionId, group]) => {
    const terminal = group.find((record) =>
      record.command === "KAHA_COMMIT_COMMAND" || record.command === "KAHA_ROLLBACK_COMMAND",
    );
    return {
      id: `transaction:${transactionId}`,
      kind: "transaction",
      primaryId: transactionId,
      destination: group.find((record) => record.destination)?.destination?.name || "Unknown",
      destinationType: group.find((record) => record.destination)?.destination?.type || "Unknown",
      journal: group[0].file,
      offset: group[0].location.offset,
      ackStatus: "Unknown",
      interpretation: terminal
        ? `${terminal.command === "KAHA_COMMIT_COMMAND" ? "Commit" : "Rollback"} command observed for this transaction.`
        : "No commit or rollback command was found in the scanned evidence. This does not prove that the transaction remained incomplete.",
      interpretationCode: terminal
        ? terminal.command === "KAHA_COMMIT_COMMAND" ? "transaction.commit" : "transaction.rollback"
        : "transaction.notObserved",
      transactionId,
      confidence: "Parsed",
      evidenceRefs: uniqueRefs(group.flatMap((record) => [sourceFileRef(record.file), parsedRef(record), ...nearbyRawRefs(record, strings)])),
    };
  });

  const structuredAdvisories = messageLinks
    .filter((link) => /\.Advisory\./.test(link.destination))
    .map((link) => ({
      ...link,
      id: `advisory:${link.journal}:${link.offset}`,
      kind: "advisory",
      interpretation: "A structured add-message command targets an Advisory destination. The OpenWire body is not decoded.",
      interpretationCode: "advisory.parsed",
    }));
  const heuristicAdvisories = messages
    .filter((message) => /\.Advisory\./.test(message.destination))
    .map((message) => ({
      id: `advisory-candidate:${message.id}`,
      kind: "advisory",
      primaryId: message.relatedId,
      destination: message.destination,
      destinationType: "Topic",
      journal: message.journal,
      offset: message.offset,
      ackStatus: "Unknown",
      interpretation: "This Advisory relation comes from printable strings and a bounded hex preview, not a decoded KahaDB command.",
      interpretationCode: "advisory.pattern",
      transactionId: "Unknown",
      confidence: message.confidence,
      evidenceRefs: uniqueRefs([
        sourceFileRef(message.journal),
        {
          id: `message-candidate:${message.id}`,
          kind: "message-candidate",
          file: message.journal,
          offset: message.offset,
          messageId: message.id,
          label: message.detectedType,
          confidence: message.confidence,
        },
        ...message.strings.map((hit) => ({
          id: `raw:${message.journal}:${hit.offset}`,
          kind: "raw-string",
          file: message.journal,
          offset: hit.offset,
          rawId: `${message.journal}:${hit.offset}`,
          label: hit.value,
          confidence: "Observed",
        })),
      ]),
    }));

  const links = [
    ...messageLinks,
    ...structuredSubscriptions,
    ...heuristicSubscriptions,
    ...transactionLinks,
    ...structuredAdvisories,
    ...heuristicAdvisories,
  ];
  return {
    links,
    counts: {
      messages: messageLinks.length,
      subscriptions: structuredSubscriptions.length + heuristicSubscriptions.length,
      transactions: transactionLinks.length,
      advisories: structuredAdvisories.length + heuristicAdvisories.length,
    },
    warnings: [
      "Correlations describe relationships found in the scanned evidence; they do not identify an outage cause.",
      "A record not found in the scanned evidence is not proof that the event never occurred.",
    ],
  };
}
