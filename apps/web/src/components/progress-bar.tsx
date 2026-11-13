export interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
}

export function ProgressBar({ value, max, label = "Progress" }: ProgressBarProps) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(Math.max(value / safeMax, 0), 1);
  const level = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "normal";

  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div className="progress-fill" data-level={level} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}
