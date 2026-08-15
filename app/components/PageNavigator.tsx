"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "@/app/lib/i18n";
import { Button } from "./ui";

export function PageNavigator({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  const { t } = useI18n();
  const safePages = Math.max(1, pages);
  const safePage = Math.min(Math.max(0, page), safePages - 1);
  const [entry, setEntry] = useState("");
  const numbered = useMemo(() => {
    const candidates = new Set([0, safePages - 1]);
    for (let value = safePage - 2; value <= safePage + 2; value += 1) {
      if (value >= 0 && value < safePages) candidates.add(value);
    }
    return [...candidates].sort((a, b) => a - b);
  }, [safePage, safePages]);
  const go = () => {
    const requested = Number.parseInt(entry, 10);
    if (!Number.isFinite(requested)) return setEntry("");
    onChange(Math.min(safePages - 1, Math.max(0, requested - 1)));
    setEntry("");
  };
  return <div className="page-navigator" aria-label={t("table.pagination")}>
    <Button variant="secondary" disabled={safePage === 0} onClick={() => onChange(safePage - 1)}><ChevronLeft size={14} />{t("common.previous")}</Button>
    <div className="page-numbers">{numbered.map((value, index) => <span key={value}>{index > 0 && value - numbered[index - 1] > 1 ? <i>…</i> : null}<button className={value === safePage ? "active" : ""} aria-current={value === safePage ? "page" : undefined} onClick={() => onChange(value)}>{value + 1}</button></span>)}</div>
    <label className="page-jump"><span>{t("table.goToPage")}</span><input inputMode="numeric" min={1} max={safePages} value={entry} placeholder={String(safePage + 1)} onChange={(event) => setEntry(event.target.value.replace(/\D/g, ""))} onKeyDown={(event) => { if (event.key === "Enter") go(); }} /><Button variant="secondary" onClick={go}>{t("table.go")}</Button></label>
    <span className="page-total">{t("table.pageOf", { page: safePage + 1, pages: safePages })}</span>
    <Button variant="secondary" disabled={safePage >= safePages - 1} onClick={() => onChange(safePage + 1)}>{t("common.next")}<ChevronRight size={14} /></Button>
  </div>;
}
