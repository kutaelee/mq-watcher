"use client";

import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ScreenTourStep = {
  target: string;
  eyebrow: string;
  title: string;
  body: string;
  caution?: string;
};

type Rect = { top: number; left: number; width: number; height: number };

export function ScreenTour({
  open,
  steps,
  step,
  previousLabel,
  nextLabel,
  finishLabel,
  closeLabel,
  onStepChange,
  onClose,
}: {
  open: boolean;
  steps: ScreenTourStep[];
  step: number;
  previousLabel: string;
  nextLabel: string;
  finishLabel: string;
  closeLabel: string;
  onStepChange: (step: number) => void;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const calloutRef = useRef<HTMLElement | null>(null);
  const active = steps[step];
  const targetSelector = active?.target;

  useEffect(() => {
    if (!open || !targetSelector) return;
    const target = document.querySelector<HTMLElement>(targetSelector);
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    const update = () => {
      const nextTarget = document.querySelector<HTMLElement>(targetSelector);
      if (!nextTarget) {
        setRect(null);
        return;
      }
      const bounds = nextTarget.getBoundingClientRect();
      setRect({ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height });
    };
    const animation = window.requestAnimationFrame(update);
    const delayed = window.setTimeout(update, 320);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(animation);
      window.clearTimeout(delayed);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, targetSelector]);

  useEffect(() => {
    if (!open) return;
    calloutRef.current?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const buttons = Array.from(calloutRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.shiftKey && current <= 0) {
        event.preventDefault();
        buttons.at(-1)?.focus();
      } else if (!event.shiftKey && current === buttons.length - 1) {
        event.preventDefault();
        buttons[0].focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [onClose, open, step]);

  if (!open || !active) return null;
  const width = Math.min(390, window.innerWidth - 32);
  const preferredLeft = rect && rect.left + rect.width + width + 32 < window.innerWidth
    ? rect.left + rect.width + 18
    : rect ? rect.left - width - 18 : (window.innerWidth - width) / 2;
  const calloutStyle = {
    width,
    left: Math.max(16, Math.min(window.innerWidth - width - 16, preferredLeft)),
    top: rect ? Math.max(16, Math.min(window.innerHeight - 330, rect.top)) : Math.max(16, (window.innerHeight - 300) / 2),
  };

  return (
    <div className="screen-tour" role="dialog" aria-modal="true" aria-label={active.title}>
      <div className="screen-tour-shade" />
      {rect ? <div className="screen-tour-highlight" style={{ top: rect.top - 7, left: rect.left - 7, width: rect.width + 14, height: rect.height + 14 }} /> : null}
      <section ref={calloutRef} tabIndex={-1} className="screen-tour-callout" style={calloutStyle}>
        <div className="screen-tour-head">
          <span>{active.eyebrow}</span>
          <button onClick={onClose} aria-label={closeLabel}><X size={17} /></button>
        </div>
        <h2>{active.title}</h2>
        <p>{active.body}</p>
        {active.caution ? <small>{active.caution}</small> : null}
        <div className="screen-tour-progress" aria-label={`${step + 1}/${steps.length}`}>
          {steps.map((item, index) => <i key={`${item.target}-${index}`} className={index === step ? "active" : ""} />)}
        </div>
        <div className="screen-tour-actions">
          <button disabled={step === 0} onClick={() => onStepChange(step - 1)}><ArrowLeft size={15} />{previousLabel}</button>
          <button className="primary" onClick={() => step === steps.length - 1 ? onClose() : onStepChange(step + 1)}>
            {step === steps.length - 1 ? finishLabel : nextLabel}{step === steps.length - 1 ? null : <ArrowRight size={15} />}
          </button>
        </div>
      </section>
    </div>
  );
}
