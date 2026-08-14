"use client";

import { ArrowRight, GitCompareArrows, Info } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import type { ScanResult } from "@/app/lib/types";
import { buildSnapshotDiff, type SnapshotDiffRow } from "@/app/lib/workbench.mjs";
import { Badge, Card } from "../ui";

type SessionOption = { id: string; name: string; result: ScanResult | null };

function valueLabel(value: number | null) {
  return value === null ? "—" : value.toLocaleString();
}

export function SnapshotCompare({ sessions }: { sessions: SessionOption[] }) {
  const { t } = useI18n();
  const ready = sessions.filter((session): session is SessionOption & { result: ScanResult } => Boolean(session.result));
  const [leftId, setLeftId] = useState(ready[0]?.id ?? "");
  const [rightId, setRightId] = useState(ready[1]?.id ?? "");

  const effectiveLeftId = ready.some((item) => item.id === leftId) ? leftId : ready[0]?.id ?? "";
  const effectiveRightId = ready.some((item) => item.id === rightId && item.id !== effectiveLeftId) ? rightId : ready.find((item) => item.id !== effectiveLeftId)?.id ?? "";
  const left = ready.find((item) => item.id === effectiveLeftId);
  const right = ready.find((item) => item.id === effectiveRightId);
  const rows = left && right ? buildSnapshotDiff(left.result, right.result) : [];
  const counts = rows.reduce((summary, row) => ({ ...summary, [row.status]: (summary[row.status] ?? 0) + 1 }), {} as Record<string, number>);

  if (ready.length < 2) return <Card className="compare-empty"><GitCompareArrows size={28} /><h2>{t("compare.needTwo.title")}</h2><p>{t("compare.needTwo.body")}</p></Card>;
  return <div className="view-stack">
    <Card className="compare-picker">
      <label><span>{t("compare.snapshotA")}</span><select value={effectiveLeftId} onChange={(event) => setLeftId(event.target.value)}>{ready.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <ArrowRight size={18} />
      <label><span>{t("compare.snapshotB")}</span><select value={effectiveRightId} onChange={(event) => setRightId(event.target.value)}>{ready.filter((item) => item.id !== effectiveLeftId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </Card>
    <div className="compare-summary">
      <Card><strong>{counts.changed ?? 0}</strong><span>{t("compare.changed")}</span></Card>
      <Card><strong>{counts["not-observed-left"] ?? 0}</strong><span>{t("compare.onlyB")}</span></Card>
      <Card><strong>{counts["not-observed-right"] ?? 0}</strong><span>{t("compare.onlyA")}</span></Card>
    </div>
    <div className="best-effort"><Info size={15} /><span>{t("compare.limit")}</span></div>
    <Card className="table-card"><div className="table-scroll"><table><thead><tr><th>{t("compare.category")}</th><th>{t("compare.observation")}</th><th>{t("compare.snapshotA")}</th><th>{t("compare.snapshotB")}</th><th>{t("compare.result")}</th></tr></thead><tbody>{rows.map((row: SnapshotDiffRow) => <tr key={row.id}><td><Badge tone="blue">{t(`compare.category.${row.category}`)}</Badge></td><td className="mono-cell">{row.key}</td><td>{valueLabel(row.leftValue)}</td><td>{valueLabel(row.rightValue)}</td><td><Badge tone={row.status === "changed" ? "amber" : "neutral"}>{t(`compare.status.${row.status}`)}</Badge>{row.delta !== null ? <small className="diff-delta">{row.delta > 0 ? "+" : ""}{row.delta.toLocaleString()}</small> : null}</td></tr>)}</tbody></table>{!rows.length ? <p className="compare-no-diff">{t("compare.noDiff")}</p> : null}</div></Card>
  </div>;
}
