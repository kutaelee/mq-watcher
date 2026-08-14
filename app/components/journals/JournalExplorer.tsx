"use client";

import { Database, FileArchive, Info } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import type { ScanResult } from "@/app/lib/types";
import { buildJournalRetentionIndex } from "@/app/lib/workbench.mjs";
import { formatBytes, formatOffset } from "@/app/lib/utils";
import { Badge, Card } from "../ui";

export function JournalExplorer({ result }: { result: ScanResult }) {
  const { t } = useI18n();
  const rows = buildJournalRetentionIndex(result);
  const [selectedId, setSelectedId] = useState(rows[0]?.id ?? "");
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  return <div className="journal-layout">
    <div className="view-stack">
      <div className="best-effort"><Info size={15} /><span>{t("journal.limit")}</span></div>
      <Card className="table-card"><div className="table-scroll"><table><thead><tr><th>{t("table.journal")}</th><th>{t("journal.sequence")}</th><th>{t("table.size")}</th><th>{t("journal.records")}</th><th>{t("journal.references")}</th><th>{t("journal.observation")}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} tabIndex={0} className={row.id === selected?.id ? "selected-row" : ""} onClick={() => setSelectedId(row.id)}><td className="file-path"><FileArchive size={14} />{row.path}</td><td>{row.fileId === null ? t("type.unknown") : row.fileId}</td><td>{formatBytes(row.size)}</td><td>{row.recordCount.toLocaleString()}</td><td>{row.referenceCount.toLocaleString()}</td><td><Badge tone={row.referenceCount ? "blue" : row.recordCount ? "amber" : "neutral"}>{t(`journal.observation.${row.observation}`)}</Badge></td></tr>)}</tbody></table>{!rows.length ? <p className="compare-no-diff">{t("journal.empty")}</p> : null}</div></Card>
    </div>
    <Card className="journal-detail">{selected ? <><div className="section-head"><div><span className="section-kicker">{t("journal.reverseIndex")}</span><h2>{selected.path}</h2></div><Database size={18} /></div><dl><div><dt>{t("journal.fileOrder")}</dt><dd>{t(`journal.sequence.${selected.sequence}`)}</dd></div><div><dt>{t("journal.offsetRange")}</dt><dd>{selected.firstOffset === null ? t("type.unknown") : `${formatOffset(selected.firstOffset)} – ${formatOffset(selected.lastOffset ?? selected.firstOffset)}`}</dd></div><div><dt>{t("journal.destinations")}</dt><dd>{selected.destinations.length ? selected.destinations.join(", ") : t("journal.notObserved")}</dd></div><div><dt>{t("journal.commands")}</dt><dd>{selected.commands.length ? selected.commands.join(", ") : t("journal.notObserved")}</dd></div></dl><h3>{t("journal.references")}</h3>{selected.references.length ? <div className="journal-refs">{selected.references.slice(0, 100).map((ref) => <div key={ref.id}><code>{ref.offset === null ? "—" : formatOffset(ref.offset)}</code><span>{ref.label}</span><Badge tone="neutral">{t(`confidence.${ref.confidence}`)}</Badge></div>)}</div> : <p className="case-muted">{t("journal.noReferences")}</p>}<p className="journal-disclaimer">{t("journal.detailLimit")}</p></> : <div className="case-list-empty"><FileArchive size={24} /><p>{t("journal.empty")}</p></div>}</Card>
  </div>;
}
