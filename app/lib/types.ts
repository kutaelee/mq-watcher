export type Confidence =
  | "Observed"
  | "Parsed"
  | "Pattern Match"
  | "Inference"
  | "Unknown";

export type StoreKind =
  | "AMQ Message Store"
  | "Temporary Message Store"
  | "Unknown Store Layout";

export type ScanFile = {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind: "journal" | "index" | "state" | "data" | "other";
  confidence: Confidence;
};

export type DestinationRecord = {
  id: string;
  type: "Queue" | "Topic" | "Unknown";
  name: string;
  decodedName: string;
  rawName: string;
  source: string;
  occurrences: number;
  confidence: Confidence;
};

export type SubscriptionRecord = {
  id: string;
  rawId: string;
  type: "TopicSubscription" | "Subscription candidate";
  connection: string;
  session: string;
  consumer: string;
  relatedStore: string;
  relatedDestination: string;
  occurrences: number;
  confidence: Confidence;
};

export type StringHit = {
  id: string;
  file: string;
  offset: number;
  value: string;
  confidence: Confidence;
};

export type MessageCandidate = {
  id: string;
  journal: string;
  offset: number;
  destination: string;
  detectedType: string;
  relatedId: string;
  operation: "CREATE" | "DELETE" | "Unknown";
  confidence: Confidence;
  strings: Array<{ offset: number; value: string }>;
  hex: string;
};

export type ScanResult = {
  signature: string;
  directoryName: string;
  storeKind: StoreKind;
  storeDescription: string;
  files: ScanFile[];
  destinations: DestinationRecord[];
  subscriptions: SubscriptionRecord[];
  messages: MessageCandidate[];
  strings: StringHit[];
  totals: {
    bytes: number;
    journalFiles: number;
    advisoryRecords: number;
    scannedBytes: number;
  };
  warnings: string[];
  truncated: {
    messages: boolean;
    strings: boolean;
  };
  scannedAt: string;
};

export type WorkerProgress = {
  type: "progress";
  file: string;
  fileIndex: number;
  fileCount: number;
  scannedBytes: number;
  totalBytes: number;
};

export type WorkerResult = { type: "complete"; result: ScanResult };
export type WorkerCancelled = { type: "cancelled" };
export type WorkerFailure = { type: "error"; message: string };
export type WorkerMessage =
  | WorkerProgress
  | WorkerResult
  | WorkerCancelled
  | WorkerFailure;

export type FileInput = {
  relativePath: string;
  file: File;
};

