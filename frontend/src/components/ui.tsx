import type { ReactNode } from "react";
import type { VaultState } from "@stellaryield/sdk";

export function Card({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function MicroLabel({ children }: { children: ReactNode }) {
  return <div className="micro-label">{children}</div>;
}

/** Label + value block used throughout the stat grids. */
export function Stat({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <MicroLabel>{label}</MicroLabel>
      <div className={`stat-value ${accent ? "stat-value-accent" : ""}`}>{value}</div>
      {hint ? (
        <div className="faint" style={{ fontSize: 12 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

const STATE_STYLES: Record<VaultState, { tone: string; label: string }> = {
  Funding: { tone: "badge-info", label: "Funding" },
  Active: { tone: "badge-accent", label: "Active" },
  Matured: { tone: "badge-warn", label: "Matured" },
  Closed: { tone: "badge-neutral", label: "Closed" },
  Cancelled: { tone: "badge-danger", label: "Cancelled" },
};

export function StateBadge({ state }: { state: VaultState }) {
  const style = STATE_STYLES[state] ?? { tone: "badge-neutral", label: state };
  return <span className={`badge ${style.tone}`}>{style.label}</span>;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "info" | "warn" | "danger";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Notice({
  children,
  tone = "neutral",
  ...rest
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "info" | "warn" | "danger";
} & React.HTMLAttributes<HTMLDivElement>) {
  const cls = tone === "neutral" ? "notice" : `notice notice-${tone}`;
  return (
    <div className={cls} {...rest}>
      <div className="notice-body">{children}</div>
    </div>
  );
}

export function Progress({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function AmountInput({
  value,
  onChange,
  suffix,
  placeholder = "0.00",
  disabled,
  onMax,
  id,
  maxLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  placeholder?: string;
  disabled?: boolean;
  onMax?: () => void;
  id?: string;
  maxLabel?: string;
}) {
  return (
    <div className="input-wrap">
      <input
        id={id}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {onMax ? (
        <button
          type="button"
          className="btn btn-soft btn-sm"
          onClick={onMax}
          aria-label={maxLabel}
        >
          Max
        </button>
      ) : null}
      <span className="input-suffix">{suffix}</span>
    </div>
  );
}
