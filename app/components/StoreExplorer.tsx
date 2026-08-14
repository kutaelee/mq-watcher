"use client";

import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Binary,
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Clipboard,
  Database,
  FileArchive,
  FileDown,
  FileSearch,
  Files,
  FolderOpen,
  Gauge,
  GitCompareArrows,
  HardDrive,
  Info,
  Languages,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Moon,
  Network,
  NotebookPen,
  OctagonX,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  ShieldCheck,
  Square,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { I18nProvider, useI18n, type Locale } from "@/app/lib/i18n";
import { readScanCache, readWorkbenchState, writeScanCache, writeWorkbenchState } from "@/app/lib/scan-cache";
import { closeSession, findReusableSession, MAX_STORE_SESSIONS, restoreSessions, sessionId } from "@/app/lib/workbench.mjs";
import type {
  CasePin,
  Confidence,
  DestinationRecord,
  EvidenceLink,
  EvidenceRef,
  FileInput,
  MessageCandidate,
  ScanFile,
  ScanResult,
  StringHit,
  StructuredRecord,
  SubscriptionRecord,
  WorkerMessage,
  WorkerProgress,
} from "@/app/lib/types";
import { compactId, formatBytes, formatOffset } from "@/app/lib/utils";
import {
  Badge,
  Button,
  Card,
  Dialog,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from "./ui";
import { SnapshotCompare } from "./compare/SnapshotCompare";
import { IncidentCase } from "./case/IncidentCase";
import { JournalExplorer } from "./journals/JournalExplorer";
import { EvidenceTimeline } from "./timeline/EvidenceTimeline";
import { EvidenceExport } from "./export/EvidenceExport";

type ViewId = "overview" | "compare" | "case" | "journals" | "timeline" | "export" | "destinations" | "subscriptions" | "messages" | "evidence" | "files";

type Selected =
  | { type: "destination"; value: DestinationRecord }
  | { type: "subscription"; value: SubscriptionRecord }
  | { type: "message"; value: MessageCandidate }
  | { type: "correlation"; value: EvidenceLink }
  | { type: "record"; value: StructuredRecord }
  | { type: "raw"; value: StringHit }
  | { type: "file"; value: ScanFile }
  | null;

type ContextHelp = { title: string; body: string; classes: string[] };
type Translator = (key: string, variables?: Record<string, string | number>) => string;

type StoreSession = {
  id: string;
  signature: string;
  name: string;
  result: ScanResult | null;
  activeView: ViewId;
  selected: Selected;
  status: "scanning" | "ready" | "error";
  progress: WorkerProgress;
  error: string;
  openedAt: string;
  restored: boolean;
};

type TableColumn<T> = {
  key: string;
  label: string;
  value: (row: T) => string | number;
  render?: (row: T) => ReactNode;
  className?: string;
  sortable?: boolean;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

const EMPTY_PROGRESS: WorkerProgress = {
  type: "progress",
  file: "",
  fileIndex: 0,
  fileCount: 0,
  scannedBytes: 0,
  totalBytes: 0,
};

const SCANNER_VERSION = "3";
const NAVIGATION: Array<{ id: ViewId; icon: typeof Gauge }> = [
  { id: "overview", icon: Gauge },
  { id: "compare", icon: GitCompareArrows },
  { id: "case", icon: NotebookPen },
  { id: "journals", icon: FileArchive },
  { id: "timeline", icon: Clock3 },
  { id: "export", icon: FileDown },
  { id: "destinations", icon: Boxes },
  { id: "subscriptions", icon: Network },
  { id: "messages", icon: MessageSquareText },
  { id: "evidence", icon: ListTree },
  { id: "files", icon: Files },
];

function makeHelp(t: Translator): Record<string, ContextHelp> {
  return {
    storeType: {
      title: t("help.storeType.title"),
      body: t("help.storeType.body"),
      classes: ["MessageDatabase", "PListStore", "KahaReferenceStore"],
    },
    advisory: {
      title: t("help.advisory.title"),
      body: t("help.advisory.body"),
      classes: ["AdvisorySupport", "AdvisoryBroker", "DestinationInfo"],
    },
    subscription: {
      title: t("help.subscription.title"),
      body: t("help.subscription.body"),
      classes: ["TopicSubscription", "ConsumerInfo"],
    },
    confidence: {
      title: t("help.confidence.title"),
      body: t("help.confidence.body"),
      classes: ["Journal", "ConsumerInfo"],
    },
    fileCursor: {
      title: t("help.cursor.title"),
      body: t("help.cursor.body"),
      classes: ["FilePendingMessageCursor", "PendingMessageCursor", "PList"],
    },
    correlation: {
      title: t("help.correlation.title"),
      body: t("help.correlation.body"),
      classes: ["MessageDatabase", "KahaAddMessageCommand", "KahaRemoveMessageCommand"],
    },
  };
}

function confidenceTone(confidence: Confidence) {
  if (confidence === "Observed") return "green" as const;
  if (confidence === "Parsed") return "blue" as const;
  if (confidence === "Pattern Match") return "amber" as const;
  if (confidence === "Inference") return "violet" as const;
  return "neutral" as const;
}

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const { t } = useI18n();
  return <Badge tone={confidenceTone(confidence)}>{t(`confidence.${confidence}`)}</Badge>;
}

function HelpButton({ help, onHelp }: { help: ContextHelp; onHelp: (help: ContextHelp) => void }) {
  const { t } = useI18n();
  return (
    <Tooltip label={t("help.open")}>
      <button className="help-button" onClick={() => onHelp(help)} aria-label={`${help.title} ${t("help.open")}`}>
        <CircleHelp size={15} />
      </button>
    </Tooltip>
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? t("copy.done") : t("copy.copy")}>
      <button
        className="copy-button"
        aria-label={t("copy.copy")}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={14} /> : <Clipboard size={14} />}
      </button>
    </Tooltip>
  );
}

function displayType(type: DestinationRecord["type"], t: Translator) {
  if (type === "Queue") return t("type.queue");
  if (type === "Topic") return t("type.topic");
  return t("type.unknown");
}

function displaySubscription(type: SubscriptionRecord["type"], t: Translator) {
  return type === "TopicSubscription" ? t("subscription.topic") : t("subscription.candidate");
}

function displayOperation(operation: MessageCandidate["operation"], t: Translator) {
  return t(`operation.${operation}`);
}

function displayStore(result: ScanResult, t: Translator) {
  return {
    label: t(`store.${result.storeKind}`),
    description: t(`store.desc.${result.storeKind}`),
  };
}

function localeCode(locale: Locale) {
  return locale === "ko" ? "ko-KR" : "en-US";
}

function makePinCandidate(selected: Selected, result: ScanResult | null): Omit<CasePin, "pinnedAt"> | null {
  if (!selected || !result) return null;
  const base = { storeSignature: result.signature, storeName: result.directoryName };
  if (selected.type === "destination") return { ...base, id: selected.value.id, kind: selected.type, label: selected.value.name, file: selected.value.source, offset: null, confidence: selected.value.confidence };
  if (selected.type === "subscription") return { ...base, id: selected.value.id, kind: selected.type, label: selected.value.rawId, file: selected.value.relatedStore, offset: null, confidence: selected.value.confidence };
  if (selected.type === "message") return { ...base, id: selected.value.id, kind: selected.type, label: `${selected.value.destination} @ ${formatOffset(selected.value.offset)}`, file: selected.value.journal, offset: selected.value.offset, confidence: selected.value.confidence };
  if (selected.type === "correlation") return { ...base, id: selected.value.id, kind: selected.type, label: selected.value.primaryId, file: selected.value.journal, offset: selected.value.offset, confidence: selected.value.confidence };
  if (selected.type === "record") return { ...base, id: `${selected.value.file}:${selected.value.location.offset}`, kind: selected.type, label: selected.value.command, file: selected.value.file, offset: selected.value.location.offset, confidence: selected.value.confidence };
  if (selected.type === "raw") return { ...base, id: selected.value.id, kind: selected.type, label: selected.value.value, file: selected.value.file, offset: selected.value.offset, confidence: selected.value.confidence };
  return { ...base, id: selected.value.path, kind: selected.type, label: selected.value.path, file: selected.value.path, offset: null, confidence: selected.value.confidence };
}

async function collectDirectoryFiles(handle: FileSystemDirectoryHandle) {
  const collected: FileInput[] = [];
  async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
    const entries: Array<[string, FileSystemHandle]> = [];
    for await (const entry of (directory as unknown as {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries()) entries.push(entry);
    entries.sort(([a], [b]) => a.localeCompare(b));
    for (const [name, child] of entries) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "directory") await walk(child as FileSystemDirectoryHandle, relativePath);
      else collected.push({ relativePath, file: await (child as FileSystemFileHandle).getFile() });
    }
  }
  await walk(handle, "");
  return collected;
}

function makeSignature(directoryName: string, files: FileInput[]) {
  const seed = files
    .map(({ relativePath, file }) => `${relativePath}:${file.size}:${file.lastModified}`)
    .sort()
    .join("|");
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${SCANNER_VERSION}:${directoryName}:${files.length}:${(hash >>> 0).toString(16)}`;
}

export default function StoreExplorer() {
  return <I18nProvider><ExplorerApp /></I18nProvider>;
}

function ExplorerApp() {
  const { t, locale, setLocale } = useI18n();
  const help = useMemo(() => makeHelp(t), [t]);
  const [sessions, setSessions] = useState<StoreSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [contextHelp, setContextHelp] = useState<ContextHelp | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [error, setError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(true);
  const [dark, setDark] = useState(false);
  const workersRef = useRef(new Map<string, Worker>());
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const result = activeSession?.result ?? null;
  const activeView = activeSession?.activeView ?? "overview";
  const selected = activeSession?.selected ?? null;
  const progress = activeSession?.progress ?? EMPTY_PROGRESS;
  const isScanning = activeSession?.status === "scanning";

  const updateSession = (id: string, update: Partial<StoreSession> | ((session: StoreSession) => Partial<StoreSession>)) => {
    setSessions((current) => current.map((session) => session.id === id
      ? { ...session, ...(typeof update === "function" ? update(session) : update) }
      : session));
  };

  const setActiveView = (view: ViewId) => {
    if (activeSessionId) updateSession(activeSessionId, { activeView: view });
  };

  const setSelected = (value: Selected) => {
    if (activeSessionId) updateSession(activeSessionId, { selected: value });
  };

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("mq-watcher-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    readWorkbenchState().then((state) => {
      const cached = restoreSessions<StoreSession>(state);
      setSessions(cached);
      setActiveSessionId(cached.some((session) => session.id === state?.activeSessionId) ? state?.activeSessionId ?? null : cached[0]?.id ?? null);
    }).catch(() => undefined).finally(() => setRestored(true));
  }, []);

  useEffect(() => {
    if (!restored) return;
    const ready = sessions.filter((session) => session.status === "ready" && session.result).map((session) => ({
      id: session.id,
      signature: session.signature,
      name: session.name,
      result: session.result as ScanResult,
      activeView: session.activeView,
      selected: session.selected,
      openedAt: session.openedAt,
    }));
    writeWorkbenchState({ id: "current", activeSessionId, sessions: ready }).catch(() => undefined);
  }, [sessions, activeSessionId, restored]);

  useEffect(() => () => {
    workersRef.current.forEach((worker) => worker.terminate());
    workersRef.current.clear();
  }, []);

  const percentage = progress.totalBytes
    ? Math.min(100, Math.round((progress.scannedBytes / progress.totalBytes) * 100))
    : 0;

  const openDirectory = async () => {
    setError("");
    if (!window.showDirectoryPicker) {
      setError(t("error.unsupported"));
      return;
    }
    try {
      setIsPreparing(true);
      const handle = await window.showDirectoryPicker({ mode: "read" });
      const files = await collectDirectoryFiles(handle);
      const signature = makeSignature(handle.name, files);
      const duplicate = findReusableSession(sessions, signature);
      if (duplicate) {
        setActiveSessionId(duplicate.id);
        setIsPreparing(false);
        return;
      }
      if (sessions.length >= MAX_STORE_SESSIONS) {
        setError(t("tabs.limit", { count: MAX_STORE_SESSIONS }));
        setIsPreparing(false);
        return;
      }
      const id = sessionId(signature);
      const cached = await readScanCache(signature).catch(() => null);
      if (cached) {
        setSessions((current) => [...current, {
          id, signature, name: handle.name, result: cached, activeView: "overview", selected: null,
          status: "ready", progress: EMPTY_PROGRESS, error: "", openedAt: new Date().toISOString(), restored: true,
        }]);
        setActiveSessionId(id);
        setIsPreparing(false);
        return;
      }
      const initialProgress = {
        ...EMPTY_PROGRESS,
        fileCount: files.length,
        totalBytes: files.reduce((sum, item) => sum + item.file.size, 0),
      };
      setSessions((current) => [...current, {
        id, signature, name: handle.name, result: null, activeView: "overview", selected: null,
        status: "scanning", progress: initialProgress, error: "", openedAt: new Date().toISOString(), restored: false,
      }]);
      setActiveSessionId(id);
      const worker = new Worker("/store-scanner.worker.js", { type: "module" });
      workersRef.current.set(id, worker);
      worker.onmessage = async (event: MessageEvent<WorkerMessage>) => {
        if (event.data.type === "progress") updateSession(id, { progress: event.data });
        if (event.data.type === "complete") {
          updateSession(id, { result: event.data.result, activeView: "overview", status: "ready", restored: false });
          worker.terminate();
          workersRef.current.delete(id);
          await writeScanCache(event.data.result).catch(() => undefined);
        }
        if (event.data.type === "cancelled") {
          worker.terminate();
          workersRef.current.delete(id);
          setSessions((current) => current.filter((session) => session.id !== id));
          setActiveSessionId((current) => current === id ? null : current);
        }
        if (event.data.type === "error") {
          updateSession(id, { error: event.data.message, status: "error" });
          worker.terminate();
          workersRef.current.delete(id);
        }
      };
      worker.onerror = (event) => {
        updateSession(id, { error: event.message || t("error.scan"), status: "error" });
        worker.terminate();
        workersRef.current.delete(id);
      };
      setIsPreparing(false);
      worker.postMessage({ type: "scan", signature, directoryName: handle.name, files });
    } catch (caught) {
      setIsPreparing(false);
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const loadDemo = async () => {
    setError("");
    try {
      const response = await fetch("/demo-result.json", { cache: "no-store" });
      if (!response.ok) throw new Error(t("error.demo"));
      const demo = await response.json() as ScanResult;
      const duplicate = findReusableSession(sessions, demo.signature);
      if (duplicate) {
        setActiveSessionId(duplicate.id);
        return;
      }
      if (sessions.length >= MAX_STORE_SESSIONS) {
        setError(t("tabs.limit", { count: MAX_STORE_SESSIONS }));
        return;
      }
      const id = sessionId(demo.signature);
      setSessions((current) => [...current, {
        id, signature: demo.signature, name: demo.directoryName, result: demo, activeView: "overview", selected: null,
        status: "ready", progress: EMPTY_PROGRESS, error: "", openedAt: new Date().toISOString(), restored: false,
      }]);
      setActiveSessionId(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const selectItem = (item: Selected) => {
    setSelected(item);
    setDetailOpen(true);
  };

  const navigate = (view: ViewId) => {
    setActiveView(view);
    if (view === "overview") setSelected(null);
  };

  const searchResults = (() => {
    const query = searchQuery.trim().toLowerCase();
    if (!result || !query) return { destinations: [], subscriptions: [], messages: [], strings: [] };
    return {
      destinations: result.destinations.filter((item) => `${item.name} ${item.source}`.toLowerCase().includes(query)).slice(0, 8),
      subscriptions: result.subscriptions.filter((item) => `${item.rawId} ${item.connection}`.toLowerCase().includes(query)).slice(0, 8),
      messages: result.messages.filter((item) => `${item.destination} ${item.relatedId} ${item.journal}`.toLowerCase().includes(query)).slice(0, 8),
      strings: result.strings.filter((item) => `${item.value} ${item.file}`.toLowerCase().includes(query)).slice(0, 12),
    };
  })();

  const searchCount = Object.values(searchResults).reduce((sum, items) => sum + items.length, 0);
  const activeNavLabel = t(`nav.${activeView}`);

  const closeStore = (id: string) => {
    workersRef.current.get(id)?.terminate();
    workersRef.current.delete(id);
    const next = closeSession(sessions, activeSessionId, id);
    setSessions(next.sessions);
    setActiveSessionId(next.activeSessionId);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand-mark"><Database size={19} /></div>
          <div>
            <div className="brand-name">MQ Watcher</div>
            <div className="brand-subtitle">{t("brand.subtitle")}</div>
          </div>
        </div>
        <div className="topbar-actions">
          <Badge tone="green"><ShieldCheck size={13} /> {t("header.readOnly")}</Badge>
          <div className="locale-switch" aria-label={t("header.language")}>
            <Languages size={14} />
            <button className={locale === "ko" ? "active" : ""} onClick={() => setLocale("ko")}>한국어</button>
            <button className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>English</button>
          </div>
          <button className="command-button" onClick={() => setSearchOpen(true)}>
            <Search size={15} /><span>{t("header.search")}</span><kbd>Ctrl K</kbd>
          </button>
          <Tooltip label={dark ? t("header.light") : t("header.dark")}>
            <button className="icon-button" onClick={() => setDark((value) => !value)} aria-label={dark ? t("header.light") : t("header.dark")}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </Tooltip>
          <Tooltip label={detailOpen ? t("header.detailClose") : t("header.detailOpen")}>
            <button className="icon-button detail-toggle" onClick={() => setDetailOpen((value) => !value)} aria-label={detailOpen ? t("header.detailClose") : t("header.detailOpen")}>
              {detailOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
          </Tooltip>
        </div>
      </header>

      <aside className="sidebar">
        <div className="source-card">
          <span className="source-label">{t("source.label")}</span>
          {result ? (
            <>
              <div className="source-name"><HardDrive size={15} /> {result.directoryName}</div>
              <div className="source-meta">{formatBytes(result.totals.bytes)} · {t("source.files", { count: result.files.length.toLocaleString(localeCode(locale)) })}</div>
              <div className="source-flags"><Badge tone={result.storeKind === "Unknown Store Layout" ? "amber" : "blue"}>{displayStore(result, t).label}</Badge></div>
            </>
          ) : <div className="source-empty">{t("source.none")}</div>}
          <Button className="source-button" onClick={openDirectory} disabled={isPreparing}>
            {isPreparing ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
            {result ? t("source.change") : t("source.open")}
          </Button>
        </div>

        <nav className="nav-list" aria-label={t("source.label")}>
          {NAVIGATION.map(({ id, icon: Icon }) => (
            <button key={id} className={`nav-item ${activeView === id ? "active" : ""}`} onClick={() => navigate(id)}>
              <Icon size={17} /><span>{t(`nav.${id}`)}</span>
              {result && id === "destinations" ? <span className="nav-count">{result.destinations.length}</span> : null}
              {result && id === "subscriptions" ? <span className="nav-count">{result.subscriptions.length}</span> : null}
              {result && id === "messages" ? <span className="nav-count">{result.messages.length}</span> : null}
              {result && id === "evidence" ? <span className="nav-count">{result.correlation.links.length}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <ShieldCheck size={16} />
          <p><strong>{t("sidebar.readOnlyTitle")}</strong>{t("sidebar.readOnlyBody")}</p>
        </div>
      </aside>

      <main className={`main-content ${detailOpen ? "with-detail" : ""}`}>
        <div className="store-tabs" role="tablist" aria-label={t("tabs.label")}>
          {sessions.map((session) => <button key={session.id} role="tab" aria-selected={session.id === activeSessionId} className={`store-tab ${session.id === activeSessionId ? "active" : ""}`} onClick={() => setActiveSessionId(session.id)}>
            {session.status === "scanning" ? <LoaderCircle className="spin" size={13} /> : <HardDrive size={13} />}
            <span title={session.name}>{session.name}</span>
            {session.restored ? <small>{t("tabs.cached")}</small> : null}
            <span className="store-tab-close" role="button" tabIndex={0} aria-label={t("tabs.close", { name: session.name })} onClick={(event) => { event.stopPropagation(); closeStore(session.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); closeStore(session.id); } }}><X size={12} /></span>
          </button>)}
          <button className="store-tab-add" onClick={openDirectory} disabled={isPreparing || sessions.length >= MAX_STORE_SESSIONS} title={t("tabs.add")}><Plus size={14} /><span>{t("tabs.add")}</span></button>
          <span className="store-tab-cap">{sessions.length}/{MAX_STORE_SESSIONS}</span>
        </div>
        <div className="page-frame">
          <div className="page-heading">
            <div>
              <div className="breadcrumb">MQ Watcher <ChevronRight size={13} /> {activeNavLabel}</div>
              <h1>{t(`view.${activeView}.title`)}</h1>
              <p>{t(`view.${activeView}.desc`)}</p>
            </div>
            {result ? <div className="heading-meta"><span>{t("page.lastScan")}</span><strong>{new Date(result.scannedAt).toLocaleString(localeCode(locale))}</strong></div> : null}
          </div>

          {contextHelp ? (
            <div className="context-help" role="status">
              <span className="context-icon"><Info size={18} /></span>
              <div><div className="context-title">{contextHelp.title}</div><p>{contextHelp.body}</p><div className="context-classes">{t("context.related")} {contextHelp.classes.map((name) => <code key={name}>{name}</code>)}</div></div>
              <button onClick={() => setContextHelp(null)} aria-label={t("help.close")}><X size={16} /></button>
            </div>
          ) : null}

          {error || activeSession?.error ? <div className="error-alert"><AlertCircle size={18} /><div><strong>{t("error.title")}</strong><p>{error || activeSession?.error}</p></div></div> : null}
          {isPreparing || isScanning ? <ScanProgress progress={progress} percentage={percentage} preparing={isPreparing} onCancel={() => activeSessionId && workersRef.current.get(activeSessionId)?.postMessage({ type: "cancel" })} /> : null}
          {!result && !isScanning && !isPreparing ? <EmptyExplorer onOpen={openDirectory} onDemo={loadDemo} /> : null}

          {result && !isScanning ? (
            <>
              {activeView === "overview" ? <Overview result={result} help={help} onHelp={setContextHelp} onNavigate={navigate} onSelect={selectItem} /> : null}
              {activeView === "compare" ? <SnapshotCompare sessions={sessions} /> : null}
              {activeView === "case" ? <IncidentCase result={result} pinCandidate={makePinCandidate(selected, result)} /> : null}
              {activeView === "journals" ? <JournalExplorer result={result} /> : null}
              {activeView === "timeline" ? <EvidenceTimeline result={result} /> : null}
              {activeView === "export" ? <EvidenceExport result={result} sessions={sessions} /> : null}
              {activeView === "destinations" ? <DestinationsView key={`${result.signature}:destinations`} stateKey={`${result.signature}:destinations`} result={result} help={help} onSelect={selectItem} onHelp={setContextHelp} /> : null}
              {activeView === "subscriptions" ? <SubscriptionsView key={`${result.signature}:subscriptions`} stateKey={`${result.signature}:subscriptions`} result={result} help={help} onSelect={selectItem} onHelp={setContextHelp} /> : null}
              {activeView === "messages" ? <MessagesView key={`${result.signature}:messages`} stateKey={`${result.signature}:messages`} result={result} onSelect={selectItem} /> : null}
              {activeView === "evidence" ? <EvidenceView key={`${result.signature}:evidence`} stateKey={`${result.signature}:evidence`} result={result} help={help} onSelect={selectItem} onHelp={setContextHelp} /> : null}
              {activeView === "files" ? <FilesView key={`${result.signature}:files`} stateKey={`${result.signature}:files`} result={result} onSelect={selectItem} /> : null}
            </>
          ) : null}
        </div>
      </main>

      {detailOpen ? <DetailPanel selected={selected} result={result} onClose={() => setDetailOpen(false)} onSelect={selectItem} /> : null}

      <Dialog open={searchOpen} onOpenChange={setSearchOpen} title={t("search.title")} description={t("search.desc")}>
        <div className="search-field"><Search size={17} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.title")} /></div>
        <ScrollArea className="search-results">
          {!searchQuery.trim() ? <div className="search-empty"><TerminalSquare size={24} /><p>{t("search.prompt")}</p></div> : null}
          {searchQuery.trim() && searchCount === 0 ? <div className="search-empty"><OctagonX size={24} /><p>{t("search.none")}</p></div> : null}
          <SearchGroup title={t("search.destinations")} items={searchResults.destinations} render={(item) => ({ title: item.name, meta: `${displayType(item.type, t)} · ${item.source}`, select: () => { selectItem({ type: "destination", value: item }); setSearchOpen(false); } })} />
          <SearchGroup title={t("search.subscriptions")} items={searchResults.subscriptions} render={(item) => ({ title: item.rawId, meta: `${displaySubscription(item.type, t)} · ${item.relatedStore}`, select: () => { selectItem({ type: "subscription", value: item }); setSearchOpen(false); } })} />
          <SearchGroup title={t("search.messages")} items={searchResults.messages} render={(item) => ({ title: `${item.destination} · ${formatOffset(item.offset)}`, meta: `${item.journal} · ${item.relatedId}`, select: () => { selectItem({ type: "message", value: item }); setSearchOpen(false); } })} />
          <SearchGroup title={t("search.rawStrings")} items={searchResults.strings} render={(item) => ({ title: item.value, meta: `${item.file} · ${formatOffset(item.offset)}`, select: () => { setActiveView("messages"); setSearchOpen(false); } })} />
        </ScrollArea>
      </Dialog>
    </div>
  );
}

function MetricCard({ label, value, sub, icon: Icon, help, onHelp }: { label: string; value: ReactNode; sub: string; icon: typeof Gauge; help?: ContextHelp; onHelp: (help: ContextHelp) => void }) {
  return <Card className="metric-card"><div className="metric-head"><span className="metric-icon"><Icon size={17} /></span><span className="metric-label">{label}</span>{help ? <HelpButton help={help} onHelp={onHelp} /> : null}</div><div className="metric-value">{value}</div><p>{sub}</p></Card>;
}

function EmptyExplorer({ onOpen, onDemo }: { onOpen: () => void; onDemo: () => void }) {
  const { t } = useI18n();
  return (
    <div className="empty-layout">
      <Card className="empty-hero">
        <div className="empty-icon"><FolderOpen size={30} /></div>
        <Badge tone="green"><ShieldCheck size={13} /> {t("empty.readOnly")}</Badge>
        <h2>{t("empty.title")}</h2><p>{t("empty.body")}</p>
        <div className="empty-actions"><Button onClick={onOpen}><FolderOpen size={16} /> {t("empty.select")}</Button><Button variant="secondary" onClick={onDemo}><ListTree size={16} /> {t("empty.demo")}</Button></div>
        <div className="empty-support"><span><Database size={15} /> {t("empty.persistent")}</span><span><FileArchive size={15} /> {t("empty.temp")}</span><span><Binary size={15} /> {t("empty.raw")}</span></div>
      </Card>
      <div className="principle-grid">
        <Card><ShieldCheck size={19} /><strong>{t("principle.protect.title")}</strong><p>{t("principle.protect.body")}</p></Card>
        <Card><ListTree size={19} /><strong>{t("principle.evidence.title")}</strong><p>{t("principle.evidence.body")}</p></Card>
        <Card><FileSearch size={19} /><strong>{t("principle.next.title")}</strong><p>{t("principle.next.body")}</p></Card>
      </div>
    </div>
  );
}

function ScanProgress({ progress, percentage, preparing, onCancel }: { progress: WorkerProgress; percentage: number; preparing: boolean; onCancel: () => void }) {
  const { t } = useI18n();
  return <Card className="scan-progress"><div className="scan-row"><div className="scan-icon"><LoaderCircle className="spin" size={20} /></div><div className="scan-copy"><div><strong>{preparing ? t("scan.preparing") : t("scan.scanning", { file: progress.file || "Store" })}</strong><span>{preparing ? t("scan.preparingBody") : t("scan.files", { current: progress.fileIndex, total: progress.fileCount })}</span></div><div className="progress-track"><span style={{ width: `${preparing ? 3 : percentage}%` }} /></div><div className="progress-meta"><span>{preparing ? t("scan.directory") : `${formatBytes(progress.scannedBytes)} / ${formatBytes(progress.totalBytes)}`}</span><strong>{preparing ? "" : `${percentage}%`}</strong></div></div>{!preparing ? <Button variant="secondary" onClick={onCancel}><Square size={13} /> {t("common.cancel")}</Button> : null}</div></Card>;
}

function Overview({ result, help, onHelp, onNavigate, onSelect }: { result: ScanResult; help: Record<string, ContextHelp>; onHelp: (help: ContextHelp) => void; onNavigate: (view: ViewId) => void; onSelect: (item: Selected) => void }) {
  const { t, locale } = useI18n();
  const store = displayStore(result, t);
  const warnings = [
    result.signature === "synthetic-demo-v1" ? t("warning.demo") : "",
    result.truncated.strings ? t("warning.strings", { count: 6000 }) : "",
    result.truncated.messages ? t("warning.messages", { count: 2500 }) : "",
    result.storeKind === "Unknown Store Layout" ? t("warning.unknownStore") : "",
  ].filter(Boolean);
  return (
    <div className="view-stack">
      <div className="metric-grid">
        <MetricCard label={t("overview.storeType")} value={store.label} sub={store.description} icon={Database} help={help.storeType} onHelp={onHelp} />
        <MetricCard label={t("overview.files")} value={result.files.length.toLocaleString(localeCode(locale))} sub={`${formatBytes(result.totals.bytes)} · ${t("overview.journalFiles", { count: result.totals.journalFiles.toLocaleString(localeCode(locale)) })}`} icon={Files} onHelp={onHelp} />
        <MetricCard label={t("overview.destinations")} value={result.destinations.length.toLocaleString(localeCode(locale))} sub={t("overview.destinationSub")} icon={Boxes} onHelp={onHelp} />
        <MetricCard label={t("overview.subscriptions")} value={result.subscriptions.length.toLocaleString(localeCode(locale))} sub={t("overview.subscriptionSub")} icon={Network} help={help.subscription} onHelp={onHelp} />
        <MetricCard label={t("overview.advisory")} value={result.totals.advisoryRecords.toLocaleString(localeCode(locale))} sub={t("overview.advisorySub")} icon={MessageSquareText} help={help.advisory} onHelp={onHelp} />
      </div>
      {warnings.length ? <div className="warning-stack">{warnings.map((warning) => <div className="warning-alert" key={warning}><AlertCircle size={16} />{warning}</div>)}</div> : null}
      <div className="overview-grid">
        <Card className="section-card">
          <div className="section-head"><div><span className="section-kicker">{t("overview.discovered")}</span><h2>{t("overview.majorDestinations")}</h2></div><Button variant="ghost" onClick={() => onNavigate("destinations")}>{t("common.seeAll")} <ChevronRight size={15} /></Button></div>
          {result.destinations.length ? <div className="compact-list">{result.destinations.slice(0, 7).map((item) => <button key={item.id} onClick={() => onSelect({ type: "destination", value: item })}><span className={`type-dot ${item.type.toLowerCase()}`} /><span className="compact-main"><strong>{item.name}</strong><small>{item.source}</small></span><ConfidenceBadge confidence={item.confidence} /><ChevronRight size={15} /></button>)}</div> : <MiniEmpty label={t("overview.noDestinations")} />}
        </Card>
        <Card className="section-card">
          <div className="section-head"><div><span className="section-kicker">{t("overview.relation")}</span><h2>{t("overview.subscriptionCandidates")}</h2></div><Button variant="ghost" onClick={() => onNavigate("subscriptions")}>{t("common.seeAll")} <ChevronRight size={15} /></Button></div>
          {result.subscriptions.length ? <div className="subscription-highlight">{result.subscriptions.slice(0, 4).map((item) => <button key={item.id} onClick={() => onSelect({ type: "subscription", value: item })}><div className="sub-icon"><Network size={17} /></div><div><strong title={item.rawId}>{compactId(item.rawId)}</strong><p>{displaySubscription(item.type, t)} · {t("table.session")} {item.session} · {t("table.consumer")} {item.consumer}</p><span>{item.relatedDestination}</span></div><ConfidenceBadge confidence={item.confidence} /></button>)}</div> : <MiniEmpty label={t("overview.noSubscriptions")} />}
        </Card>
      </div>
      <Card className="relation-card">
        <div className="section-head"><div><span className="section-kicker">{t("overview.path")}</span><h2>{t("overview.pathTitle")}</h2></div><HelpButton help={help.fileCursor} onHelp={onHelp} /></div>
        <div className="relationship-flow">{[
          result.files.find((item) => /tmpdb\.data/i.test(item.name))?.name || t("overview.storeFile"),
          result.subscriptions[0] ? displaySubscription(result.subscriptions[0].type, t) : t("overview.subscriptionCandidate"),
          result.subscriptions[0] ? compactId(result.subscriptions[0].rawId, 16, 8) : t("overview.consumerId"),
          result.destinations.find((item) => /Advisory/.test(item.name))?.name || t("overview.destination"),
          t("overview.relatedJournal"),
        ].map((item, index, all) => <Fragment key={`${item}-${index}`}><button>{item}</button>{index < all.length - 1 ? <ChevronRight size={15} /> : null}</Fragment>)}</div>
        <p className="relation-note"><Info size={15} /> {t("overview.pathNote")}</p>
      </Card>
    </div>
  );
}

function usePersistentState<T>(key: string, initial: T) {
  const storageKey = `mq-watcher-ui:${key}`;
  const read = () => {
    if (typeof localStorage === "undefined") return initial;
    try {
      const value = localStorage.getItem(storageKey);
      return value === null ? initial : JSON.parse(value) as T;
    } catch {
      return initial;
    }
  };
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* best-effort UI state */ }
  }, [storageKey, value]);
  return [value, setValue] as const;
}

function DataTable<T>({ rows, columns, rowKey, onRowClick, empty, stateKey }: { rows: T[]; columns: TableColumn<T>[]; rowKey: (row: T) => string; onRowClick: (row: T) => void; empty: string; stateKey: string }) {
  const { t, locale } = useI18n();
  const [sort, setSort] = usePersistentState<{ key: string; direction: "asc" | "desc" } | null>(`${stateKey}:sort`, null);
  const [page, setPage] = usePersistentState(`${stateKey}:page`, 0);
  const [pageSize, setPageSize] = usePersistentState(`${stateKey}:page-size`, 25);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column) return rows;
    return [...rows].sort((a, b) => {
      const left = column.value(a);
      const right = column.value(b);
      const compared = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), localeCode(locale), { numeric: true, sensitivity: "base" });
      return sort.direction === "asc" ? compared : -compared;
    });
  }, [rows, columns, sort, locale]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const visible = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const start = sorted.length ? safePage * pageSize + 1 : 0;
  const end = Math.min(sorted.length, (safePage + 1) * pageSize);

  if (!rows.length) return <MiniEmpty label={empty} />;
  return (
    <>
      <Card className="table-card"><div className="table-scroll"><table><thead><tr>{columns.map((column) => {
        const active = sort?.key === column.key;
        const nextDirection = active && sort.direction === "asc" ? "desc" : "asc";
        return <th key={column.key} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>{column.sortable === false ? column.label : <button className="sort-button" aria-label={t("table.sort", { column: column.label })} onClick={() => { setSort({ key: column.key, direction: nextDirection }); setPage(0); }}>{column.label}{!active ? <ArrowUpDown size={13} /> : sort.direction === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}</button>}</th>;
      })}</tr></thead><tbody>{visible.map((row) => <tr key={rowKey(row)} tabIndex={0} onClick={() => onRowClick(row)} onKeyDown={(event) => activateRow(event, () => onRowClick(row))}>{columns.map((column) => <td key={column.key} className={column.className}>{column.render ? column.render(row) : column.value(row)}</td>)}</tr>)}</tbody></table></div></Card>
      <div className="table-footer"><label>{t("table.pageSize")}<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}>{[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label><span>{t("table.range", { start, end, total: sorted.length.toLocaleString(localeCode(locale)) })}</span><div><Button variant="secondary" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>{t("common.previous")}</Button><span>{safePage + 1} / {pages}</span><Button variant="secondary" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>{t("common.next")}</Button></div></div>
    </>
  );
}

function FilterBar({ value, onChange, placeholder, count, onHelp }: { value: string; onChange: (value: string) => void; placeholder: string; count: number; onHelp?: () => void }) {
  const { t, locale } = useI18n();
  return <Card className="filter-bar"><div className="inline-search"><Search size={16} /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></div><div className="filter-count"><strong>{t("common.items", { count: count.toLocaleString(localeCode(locale)) })}</strong>{onHelp ? <button className="help-button" onClick={onHelp} aria-label={t("help.open")}><CircleHelp size={15} /></button> : null}</div></Card>;
}

function DestinationsView({ result, help, onSelect, onHelp, stateKey }: { result: ScanResult; help: Record<string, ContextHelp>; onSelect: (item: Selected) => void; onHelp: (help: ContextHelp) => void; stateKey: string }) {
  const { t } = useI18n();
  const [filter, setFilter] = usePersistentState(`${stateKey}:filter`, "");
  const rows = result.destinations.filter((item) => `${item.name} ${item.type} ${item.source}`.toLowerCase().includes(filter.toLowerCase()));
  const columns: TableColumn<DestinationRecord>[] = [
    { key: "type", label: t("table.type"), value: (item) => displayType(item.type, t), render: (item) => <Badge tone={item.type === "Queue" ? "blue" : item.type === "Topic" ? "violet" : "neutral"}>{displayType(item.type, t)}</Badge> },
    { key: "destination", label: t("table.destination"), value: (item) => item.name, className: "mono-cell" },
    { key: "source", label: t("table.source"), value: (item) => item.source, render: (item) => <span title={item.source}>{compactId(item.source, 34, 16)}</span> },
    { key: "occurrences", label: t("table.occurrences"), value: (item) => item.occurrences, render: (item) => item.occurrences.toLocaleString() },
    { key: "evidence", label: t("table.evidence"), value: (item) => t(`confidence.${item.confidence}`), render: (item) => <ConfidenceBadge confidence={item.confidence} /> },
  ];
  return <div className="view-stack"><FilterBar value={filter} onChange={setFilter} placeholder={t("filter.destination")} count={rows.length} onHelp={() => onHelp(help.confidence)} /><DataTable stateKey={stateKey} rows={rows} columns={columns} rowKey={(item) => item.id} onRowClick={(item) => onSelect({ type: "destination", value: item })} empty={t("empty.destinationFilter")} /></div>;
}

function SubscriptionsView({ result, help, onSelect, onHelp, stateKey }: { result: ScanResult; help: Record<string, ContextHelp>; onSelect: (item: Selected) => void; onHelp: (help: ContextHelp) => void; stateKey: string }) {
  const { t } = useI18n();
  const [filter, setFilter] = usePersistentState(`${stateKey}:filter`, "");
  const rows = result.subscriptions.filter((item) => `${item.rawId} ${item.connection} ${item.relatedDestination}`.toLowerCase().includes(filter.toLowerCase()));
  const columns: TableColumn<SubscriptionRecord>[] = [
    { key: "type", label: t("table.type"), value: (item) => displaySubscription(item.type, t), render: (item) => displaySubscription(item.type, t) },
    { key: "connection", label: t("table.connection"), value: (item) => item.connection, className: "mono-cell", render: (item) => <span title={item.connection}>{compactId(item.connection, 25, 10)}</span> },
    { key: "session", label: t("table.session"), value: (item) => Number(item.session) || item.session },
    { key: "consumer", label: t("table.consumer"), value: (item) => Number(item.consumer) || item.consumer },
    { key: "store", label: t("table.relatedStore"), value: (item) => item.relatedStore, render: (item) => <span title={item.relatedStore}>{compactId(item.relatedStore, 26, 12)}</span> },
    { key: "evidence", label: t("table.evidence"), value: (item) => t(`confidence.${item.confidence}`), render: (item) => <ConfidenceBadge confidence={item.confidence} /> },
  ];
  return <div className="view-stack"><FilterBar value={filter} onChange={setFilter} placeholder={t("filter.subscription")} count={rows.length} onHelp={() => onHelp(help.subscription)} /><DataTable stateKey={stateKey} rows={rows} columns={columns} rowKey={(item) => item.id} onRowClick={(item) => onSelect({ type: "subscription", value: item })} empty={t("empty.subscription")} /></div>;
}

function MessagesView({ result, onSelect, stateKey }: { result: ScanResult; onSelect: (item: Selected) => void; stateKey: string }) {
  const { t } = useI18n();
  const [filter, setFilter] = usePersistentState(`${stateKey}:filter`, "");
  const rows = result.messages.filter((item) => `${item.journal} ${item.destination} ${item.detectedType} ${item.relatedId}`.toLowerCase().includes(filter.toLowerCase()));
  const columns: TableColumn<MessageCandidate>[] = [
    { key: "journal", label: t("table.journal"), value: (item) => item.journal },
    { key: "offset", label: t("table.offset"), value: (item) => item.offset, className: "mono-cell", render: (item) => formatOffset(item.offset) },
    { key: "destination", label: t("table.detectedDestination"), value: (item) => item.destination, className: "mono-cell" },
    { key: "type", label: t("table.type"), value: (item) => item.detectedType },
    { key: "operation", label: t("table.operation"), value: (item) => displayOperation(item.operation, t), render: (item) => <Badge tone={item.operation === "Unknown" ? "neutral" : "blue"}>{displayOperation(item.operation, t)}</Badge> },
    { key: "relatedId", label: t("table.relatedId"), value: (item) => item.relatedId, className: "mono-cell", render: (item) => <span title={item.relatedId}>{compactId(item.relatedId, 20, 9)}</span> },
  ];
  return <div className="view-stack"><FilterBar value={filter} onChange={setFilter} placeholder={t("filter.message")} count={rows.length} /><DataTable stateKey={stateKey} rows={rows} columns={columns} rowKey={(item) => item.id} onRowClick={(item) => onSelect({ type: "message", value: item })} empty={t("empty.message")} /></div>;
}

function evidenceKind(kind: EvidenceLink["kind"], t: Translator) {
  return t(`evidence.kind.${kind}`);
}

function EvidenceView({ result, help, onSelect, onHelp, stateKey }: { result: ScanResult; help: Record<string, ContextHelp>; onSelect: (item: Selected) => void; onHelp: (help: ContextHelp) => void; stateKey: string }) {
  const { t } = useI18n();
  const [filter, setFilter] = usePersistentState(`${stateKey}:filter`, "");
  const rows = result.correlation.links.filter((item) =>
    `${item.kind} ${item.primaryId} ${item.destination} ${item.journal} ${item.transactionId}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const columns: TableColumn<EvidenceLink>[] = [
    { key: "kind", label: t("table.entity"), value: (item) => evidenceKind(item.kind, t), render: (item) => <Badge tone={item.kind === "advisory" ? "violet" : item.kind === "transaction" ? "amber" : "blue"}>{evidenceKind(item.kind, t)}</Badge> },
    { key: "id", label: t("table.relatedId"), value: (item) => item.primaryId, className: "mono-cell", render: (item) => <span title={item.primaryId}>{compactId(item.primaryId, 24, 10)}</span> },
    { key: "destination", label: t("table.destination"), value: (item) => item.destination, className: "mono-cell" },
    { key: "journal", label: t("table.journal"), value: (item) => item.journal, render: (item) => <span title={item.journal}>{compactId(item.journal, 28, 12)}</span> },
    { key: "offset", label: t("table.offset"), value: (item) => item.offset ?? -1, className: "mono-cell", render: (item) => item.offset === null ? t("type.unknown") : formatOffset(item.offset) },
    { key: "evidence", label: t("table.evidence"), value: (item) => t(`confidence.${item.confidence}`), render: (item) => <ConfidenceBadge confidence={item.confidence} /> },
  ];
  return <div className="view-stack"><FilterBar value={filter} onChange={setFilter} placeholder={t("filter.evidence")} count={rows.length} onHelp={() => onHelp(help.correlation)} /><div className="best-effort"><Info size={15} /><span>{t("evidence.limit")}</span></div><DataTable stateKey={stateKey} rows={rows} columns={columns} rowKey={(item) => item.id} onRowClick={(item) => onSelect({ type: "correlation", value: item })} empty={t("empty.evidence")} /></div>;
}

function FilesView({ result, onSelect, stateKey }: { result: ScanResult; onSelect: (item: Selected) => void; stateKey: string }) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = usePersistentState(`${stateKey}:filter`, "");
  const rows = result.files.filter((item) => item.path.toLowerCase().includes(filter.toLowerCase()));
  const columns: TableColumn<ScanFile>[] = [
    { key: "path", label: t("table.path"), value: (item) => item.path, className: "file-path", render: (item) => <><FileArchive size={15} /> {item.path}</> },
    { key: "kind", label: t("table.kind"), value: (item) => t(`file.${item.kind}`), render: (item) => <Badge tone={item.kind === "journal" ? "violet" : item.kind === "index" ? "blue" : "neutral"}>{t(`file.${item.kind}`)}</Badge> },
    { key: "size", label: t("table.size"), value: (item) => item.size, render: (item) => formatBytes(item.size) },
    { key: "modified", label: t("table.modified"), value: (item) => item.modified, render: (item) => new Date(item.modified).toLocaleString(localeCode(locale)) },
    { key: "evidence", label: t("table.evidence"), value: (item) => t(`confidence.${item.confidence}`), render: (item) => <ConfidenceBadge confidence={item.confidence} /> },
  ];
  return <div className="view-stack"><FilterBar value={filter} onChange={setFilter} placeholder={t("filter.file")} count={rows.length} /><DataTable stateKey={stateKey} rows={rows} columns={columns} rowKey={(item) => item.path} onRowClick={(item) => onSelect({ type: "file", value: item })} empty={t("empty.fileFilter")} /></div>;
}

function DetailPanel({ selected, result, onClose, onSelect }: { selected: Selected; result: ScanResult | null; onClose: () => void; onSelect: (item: Selected) => void }) {
  const { t } = useI18n();
  return <aside className="detail-panel"><div className="detail-head"><div><span>{t("detail.panel")}</span><strong>{selected ? detailTitle(selected) : t("detail.selected")}</strong></div><button onClick={onClose} aria-label={t("header.detailClose")}><X size={17} /></button></div><ScrollArea className="detail-scroll">{!selected ? <div className="detail-empty"><PanelRightOpen size={27} /><h3>{t("detail.emptyTitle")}</h3><p>{t("detail.emptyBody")}</p></div> : null}{selected?.type === "destination" ? <DestinationDetail value={selected.value} result={result} onSelect={onSelect} /> : null}{selected?.type === "subscription" ? <SubscriptionDetail value={selected.value} result={result} onSelect={onSelect} /> : null}{selected?.type === "message" ? <MessageDetail value={selected.value} /> : null}{selected?.type === "correlation" ? <CorrelationDetail value={selected.value} result={result} onSelect={onSelect} /> : null}{selected?.type === "record" ? <StructuredRecordDetail value={selected.value} result={result} onSelect={onSelect} /> : null}{selected?.type === "raw" ? <RawEvidenceDetail value={selected.value} /> : null}{selected?.type === "file" ? <FileDetail value={selected.value} result={result} onSelect={onSelect} /> : null}</ScrollArea></aside>;
}

function detailTitle(selected: NonNullable<Selected>) {
  if (selected.type === "destination") return selected.value.name;
  if (selected.type === "subscription") return compactId(selected.value.rawId, 20, 10);
  if (selected.type === "message") return formatOffset(selected.value.offset);
  if (selected.type === "correlation") return compactId(selected.value.primaryId, 20, 10);
  if (selected.type === "record") return selected.value.command;
  if (selected.type === "raw") return formatOffset(selected.value.offset);
  return selected.value.name;
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="detail-section"><h3>{title}</h3>{children}</section>;
}

function DetailField({ label, value, mono = false, copy = false }: { label: string; value: ReactNode; mono?: boolean; copy?: boolean }) {
  const text = typeof value === "string" ? value : "";
  return <div className="detail-field"><span>{label}</span><div className={mono ? "mono-value" : ""}>{value}{copy && text ? <CopyButton value={text} /> : null}</div></div>;
}

function DestinationDetail({ value, result, onSelect }: { value: DestinationRecord; result: ScanResult | null; onSelect: (item: Selected) => void }) {
  const { t } = useI18n();
  const related = result?.messages.filter((item) => item.destination === value.name).slice(0, 8) || [];
  return <div className="detail-body"><div className="detail-badges"><Badge tone={value.type === "Queue" ? "blue" : "violet"}>{displayType(value.type, t)}</Badge><ConfidenceBadge confidence={value.confidence} /></div><DetailSection title={t("detail.destination")}><DetailField label={t("detail.name")} value={value.name} mono copy /><DetailField label={t("detail.decoded")} value={value.decodedName} mono copy /><DetailField label={t("detail.rawEncoded")} value={value.rawName} mono /><DetailField label={t("detail.detectedFrom")} value={value.source} mono copy /><DetailField label={t("detail.occurrences")} value={value.occurrences.toLocaleString()} /></DetailSection><DetailSection title={t("detail.relatedRecords")}>{related.length ? <div className="related-list">{related.map((item) => <button key={item.id} onClick={() => onSelect({ type: "message", value: item })}><span>{formatOffset(item.offset)}</span><small>{item.journal}</small><ChevronRight size={14} /></button>)}</div> : <MiniEmpty label={t("detail.noRelatedMessages")} />}</DetailSection></div>;
}

function SubscriptionDetail({ value, result, onSelect }: { value: SubscriptionRecord; result: ScanResult | null; onSelect: (item: Selected) => void }) {
  const { t } = useI18n();
  const related = result?.messages.filter((item) => item.relatedId === value.rawId || (value.relatedDestination !== "Unknown" && item.destination === value.relatedDestination)).slice(0, 8) || [];
  return <div className="detail-body"><div className="detail-badges"><Badge tone="violet">{displaySubscription(value.type, t)}</Badge><ConfidenceBadge confidence={value.confidence} /></div><div className="best-effort"><Info size={15} /><span>{t("detail.bestEffort")}</span></div><DetailSection title={t("detail.parsedId")}><DetailField label={t("detail.rawId")} value={value.rawId} mono copy /><DetailField label={t("detail.connectionPrefix")} value={value.connection} mono copy /><DetailField label={t("table.session")} value={value.session} mono /><DetailField label={t("table.consumer")} value={value.consumer} mono /></DetailSection><DetailSection title={t("detail.detectedRelation")}><DetailField label={t("table.relatedStore")} value={value.relatedStore} mono /><DetailField label={t("detail.relatedDestination")} value={value.relatedDestination} mono /><DetailField label={t("detail.occurrences")} value={value.occurrences.toLocaleString()} /></DetailSection><DetailSection title={t("detail.relatedRecords")}>{related.length ? <div className="related-list">{related.map((item) => <button key={item.id} onClick={() => onSelect({ type: "message", value: item })}><span>{formatOffset(item.offset)}</span><small>{item.destination}</small><ChevronRight size={14} /></button>)}</div> : <MiniEmpty label={t("detail.noNearbyRecord")} />}</DetailSection></div>;
}

function MessageDetail({ value }: { value: MessageCandidate }) {
  const { t } = useI18n();
  const sourceTrace = sourceTraceFor(value, t);
  return <div className="detail-body"><div className="detail-badges"><Badge tone="blue">{t("detail.recordCandidate")}</Badge><ConfidenceBadge confidence={value.confidence} /></div><Tabs defaultValue="summary" className="detail-tabs"><TabsList><TabsTrigger value="summary">{t("tab.summary")}</TabsTrigger><TabsTrigger value="strings">{t("tab.strings")}</TabsTrigger><TabsTrigger value="hex">{t("tab.hex")}</TabsTrigger><TabsTrigger value="source">{t("tab.source")}</TabsTrigger></TabsList><TabsContent value="summary"><DetailSection title={t("detail.recordSummary")}><DetailField label={t("table.journal")} value={value.journal} mono copy /><DetailField label={t("table.offset")} value={formatOffset(value.offset)} mono copy /><DetailField label={t("table.destination")} value={value.destination} mono copy /><DetailField label={t("detail.detectedType")} value={value.detectedType === "Unknown" ? t("type.unknown") : value.detectedType} /><DetailField label={t("table.relatedId")} value={value.relatedId === "Unknown" ? t("type.unknown") : value.relatedId} mono copy /><DetailField label={t("table.operation")} value={<Badge tone={value.operation === "Unknown" ? "neutral" : "blue"}>{displayOperation(value.operation, t)}</Badge>} /></DetailSection><div className="unknown-note"><AlertCircle size={15} /> {t("detail.unknownOperation")}</div></TabsContent><TabsContent value="strings"><DetailSection title={t("detail.nearbyStrings")}><div className="strings-list">{value.strings.length ? value.strings.map((item, index) => <div key={`${item.offset}-${index}`}><code>{formatOffset(item.offset)}</code><span>{item.value}</span><CopyButton value={item.value} /></div>) : <MiniEmpty label={t("detail.noStrings")} />}</div></DetailSection></TabsContent><TabsContent value="hex"><DetailSection title={t("detail.hexPreview")}><pre className="hex-view">{value.hex || t("type.unknown")}</pre><p className="tab-note">{t("detail.hexNote")}</p></DetailSection></TabsContent><TabsContent value="source"><div className="source-version-note"><Info size={15} />{t("detail.sourceVersionNote")}</div><DetailSection title={t("detail.sourceTrace")}><div className="source-trace">{sourceTrace.map((item, index) => <div key={item.name}><span>{index + 1}</span><div><strong>{item.name}</strong><p>{item.why}</p><code>{item.focus}</code></div></div>)}</div></DetailSection></TabsContent></Tabs></div>;
}

function resolveEvidenceRef(ref: EvidenceRef, result: ScanResult | null): Selected {
  if (!result) return null;
  if (ref.kind === "parsed-record") {
    const record = result.structured.records.find((item) => `parsed:${item.file}:${item.location.offset}` === ref.recordId);
    return record ? { type: "record", value: record } : null;
  }
  if (ref.kind === "raw-string") {
    const raw = result.strings.find((item) => item.id === ref.rawId || (item.file === ref.file && item.offset === ref.offset));
    return raw ? { type: "raw", value: raw } : null;
  }
  if (ref.kind === "message-candidate") {
    const message = result.messages.find((item) => item.id === ref.messageId);
    return message ? { type: "message", value: message } : null;
  }
  if (ref.kind === "subscription-candidate") {
    const subscription = result.subscriptions.find((item) => item.id === ref.subscriptionId);
    return subscription ? { type: "subscription", value: subscription } : null;
  }
  const file = result.files.find((item) => item.path === ref.file);
  return file ? { type: "file", value: file } : null;
}

function CorrelationDetail({ value, result, onSelect }: { value: EvidenceLink; result: ScanResult | null; onSelect: (item: Selected) => void }) {
  const { t } = useI18n();
  const file = result?.files.find((item) => item.path === value.journal);
  return <div className="detail-body"><div className="detail-badges"><Badge tone={value.kind === "advisory" ? "violet" : "blue"}>{evidenceKind(value.kind, t)}</Badge><ConfidenceBadge confidence={value.confidence} /></div><div className="best-effort"><Info size={15} /><span>{t("evidence.limit")}</span></div><DetailSection title={t("detail.evidenceLink")}><DetailField label={t("table.relatedId")} value={value.primaryId} mono copy /><DetailField label={t("table.destination")} value={value.destination} mono copy /><DetailField label={t("table.journal")} value={file ? <button className="text-link" onClick={() => onSelect({ type: "file", value: file })}>{value.journal}</button> : value.journal} mono /><DetailField label={t("table.offset")} value={value.offset === null ? t("type.unknown") : formatOffset(value.offset)} mono /><DetailField label={t("detail.ackStatus")} value={t(`evidence.ack.${value.ackStatus}`)} /><DetailField label={t("detail.transaction")} value={value.transactionId} mono /></DetailSection><DetailSection title={t("detail.interpretation")}><p className="tab-note">{value.interpretationCode ? t(`evidence.interpretation.${value.interpretationCode}`) : value.interpretation}</p></DetailSection><DetailSection title={t("detail.evidenceRefs")}><div className="related-list">{value.evidenceRefs.map((ref) => { const target = resolveEvidenceRef(ref, result); return <button key={ref.id} disabled={!target} onClick={() => target && onSelect(target)}><span>{ref.kind}</span><small>{ref.file}{ref.offset === null ? "" : ` · ${formatOffset(ref.offset)}`}</small><ConfidenceBadge confidence={ref.confidence} /><ChevronRight size={14} /></button>; })}</div></DetailSection></div>;
}

function StructuredRecordDetail({ value, result, onSelect }: { value: StructuredRecord; result: ScanResult | null; onSelect: (item: Selected) => void }) {
  const { t } = useI18n();
  const file = result?.files.find((item) => item.path === value.file);
  const related = result?.correlation.links.filter((link) => link.evidenceRefs.some((ref) => ref.recordId === `parsed:${value.file}:${value.location.offset}`)) || [];
  return <div className="detail-body"><div className="detail-badges"><Badge tone="blue">{t("detail.record")}</Badge><ConfidenceBadge confidence={value.confidence} /></div><DetailSection title={value.command}><DetailField label={t("table.journal")} value={file ? <button className="text-link" onClick={() => onSelect({ type: "file", value: file })}>{value.file}</button> : value.file} mono /><DetailField label={t("table.offset")} value={formatOffset(value.location.offset)} mono copy /><DetailField label={t("table.size")} value={value.location.size.toLocaleString()} /><DetailField label={t("table.destination")} value={value.destination?.name || t("type.unknown")} mono /><DetailField label={t("table.relatedId")} value={value.messageId || value.subscriptionKey || t("type.unknown")} mono /><DetailField label={t("detail.transaction")} value={value.transactionId || t("type.unknown")} mono /></DetailSection><DetailSection title={t("detail.relatedRecords")}><div className="related-list">{related.map((link) => <button key={link.id} onClick={() => onSelect({ type: "correlation", value: link })}><span>{evidenceKind(link.kind, t)}</span><small>{link.primaryId}</small><ChevronRight size={14} /></button>)}</div></DetailSection></div>;
}

function RawEvidenceDetail({ value }: { value: StringHit }) {
  const { t } = useI18n();
  return <div className="detail-body"><div className="detail-badges"><Badge tone="green">{t("detail.rawString")}</Badge><ConfidenceBadge confidence={value.confidence} /></div><DetailSection title={t("detail.rawString")}><DetailField label={t("table.journal")} value={value.file} mono copy /><DetailField label={t("table.offset")} value={formatOffset(value.offset)} mono copy /><DetailField label={t("detail.value")} value={value.value} mono copy /></DetailSection></div>;
}

function FileDetail({ value, result, onSelect }: { value: ScanFile; result: ScanResult | null; onSelect: (item: Selected) => void }) {
  const { t, locale } = useI18n();
  const related = result?.messages.filter((item) => item.journal === value.path).slice(0, 10) || [];
  return <div className="detail-body"><div className="detail-badges"><Badge tone={value.kind === "journal" ? "violet" : "neutral"}>{t(`file.${value.kind}`)}</Badge><ConfidenceBadge confidence={value.confidence} /></div><DetailSection title={t("detail.fileMetadata")}><DetailField label={t("detail.fileName")} value={value.name} mono copy /><DetailField label={t("detail.relativePath")} value={value.path} mono copy /><DetailField label={t("table.size")} value={formatBytes(value.size)} /><DetailField label={t("detail.lastModified")} value={new Date(value.modified).toLocaleString(localeCode(locale))} /></DetailSection><div className="best-effort"><ShieldCheck size={15} /><span>{t("detail.fileReadOnly")}</span></div><DetailSection title={t("detail.relatedRecords")}>{related.length ? <div className="related-list">{related.map((item) => <button key={item.id} onClick={() => onSelect({ type: "message", value: item })}><span>{formatOffset(item.offset)}</span><small>{item.destination}</small><ChevronRight size={14} /></button>)}</div> : <MiniEmpty label={t("detail.noFileRecords")} />}</DetailSection></div>;
}

function sourceTraceFor(value: MessageCandidate, t: Translator) {
  if (/Advisory/.test(value.destination)) return [
    { name: "AdvisorySupport", why: t("source.advisorySupport.why"), focus: "getDestinationAdvisoryTopic() / TEMP_QUEUE_ADVISORY_TOPIC" },
    { name: "DestinationInfo", why: t("source.destinationInfo.why"), focus: "getOperationType() / getDestination()" },
    { name: "AdvisoryBroker", why: t("source.advisoryBroker.why"), focus: "fireAdvisory() / addDestinationInfo()" },
    { name: "TopicSubscription", why: t("source.topicSubscription.why"), focus: "matched() / isFull() / dispatch()" },
  ];
  return [
    { name: "ActiveMQDestination", why: t("source.destination.why"), focus: "getDestinationType() / getPhysicalName()" },
    { name: "PendingMessageCursor", why: t("source.cursor.why"), focus: "addMessageLast() / size()" },
    { name: "Queue / Topic", why: t("source.queueTopic.why"), focus: "send() / acknowledge() / dispatch()" },
  ];
}

function MiniEmpty({ label }: { label: string }) {
  return <div className="mini-empty"><FileSearch size={21} /><span>{label}</span></div>;
}

function SearchGroup<T>({ title, items, render }: { title: string; items: T[]; render: (item: T) => { title: string; meta: string; select: () => void } }) {
  if (!items.length) return null;
  return <section className="search-group"><h3>{title} <span>{items.length}</span></h3>{items.map((item, index) => { const view = render(item); return <button key={`${title}-${index}`} onClick={view.select}><Search size={14} /><span><strong>{view.title}</strong><small>{view.meta}</small></span><ChevronRight size={14} /></button>; })}</section>;
}

function activateRow(event: KeyboardEvent, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}
