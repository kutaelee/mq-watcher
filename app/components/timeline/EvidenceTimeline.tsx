"use client";

import { Clock3, FileArchive, Info, Search } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import type { ScanResult } from "@/app/lib/types";
import { buildEvidenceTimeline, MAX_TIMELINE_EVENTS } from "@/app/lib/workbench.mjs";
import { compactId, formatOffset } from "@/app/lib/utils";
import { Badge, Card } from "../ui";
import { PageNavigator } from "../PageNavigator";

const PAGE_SIZE = 100;

export function EvidenceTimeline({ result, onTrace }: { result: ScanResult; onTrace: (messageId: string) => void }) {
  const { t } = useI18n();
  const timeline = buildEvidenceTimeline(result);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(0);
  const filtered = timeline.events.filter((event) => (category === "all" || event.category === category) && `${event.command} ${event.destination} ${event.primaryId} ${event.file}`.toLowerCase().includes(query.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  return <div className="view-stack">
    <Card className="timeline-toolbar"><div className="inline-search"><Clock3 size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder={t("timeline.search")} /></div><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(0); }}><option value="all">{t("timeline.all")}</option><option value="message">{t("timeline.category.message")}</option><option value="transaction">{t("timeline.category.transaction")}</option><option value="subscription">{t("timeline.category.subscription")}</option><option value="record">{t("timeline.category.record")}</option></select><Badge tone="blue">{t("timeline.count", { count: filtered.length })}</Badge></Card>
    <div className="best-effort"><Info size={15} /><span>{t("timeline.orderLimit")}</span></div>
    {timeline.truncated ? <div className="warning-alert"><Info size={15} />{t("timeline.truncated", { shown: MAX_TIMELINE_EVENTS, total: timeline.total })}</div> : null}
    <Card className="timeline-card">{visible.length ? <div className="timeline-list">{visible.map((event, index) => {
      const firstInJournal = index === 0 || visible[index - 1]?.file !== event.file;
      return <div key={event.id}>{firstInJournal ? <div className="timeline-journal"><FileArchive size={14} /><strong>{event.file}</strong><span>{t("timeline.journalGroup")}</span></div> : null}<div className="timeline-event"><div className="timeline-marker"><span>{event.offset === null ? "—" : formatOffset(event.offset)}</span></div><div className="timeline-content"><div><Badge tone={event.category === "transaction" ? "amber" : event.category === "subscription" ? "violet" : "blue"}>{t(`timeline.category.${event.category}`)}</Badge><strong>{event.command}</strong><Badge tone="neutral">{t(`confidence.${event.confidence}`)}</Badge></div><p>{event.destination} · {event.category === "message" && event.primaryId !== "Unknown" ? <button className="text-link" onClick={() => onTrace(event.primaryId)}><Search size={12} /><code title={event.primaryId}>{compactId(event.primaryId, 28, 12)}</code></button> : <code title={event.primaryId}>{compactId(event.primaryId, 28, 12)}</code>}</p><small>{t("timeline.status", { status: event.status })}</small></div></div></div>;
    })}</div> : <p className="compare-no-diff">{t("timeline.empty")}</p>}</Card>
    <div className="timeline-pages"><PageNavigator page={safePage} pages={pages} onChange={setPage} /></div>
  </div>;
}
