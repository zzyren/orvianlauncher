interface ProgressBarProps {
  /** 0 to 1. Omit for work whose length is unknown. */
  value?: number
  label: string
  className?: string
}

export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const determinate = typeof value === 'number'
  const clamped = determinate ? Math.min(1, Math.max(0, value)) : 0
  return (
    <div
      className={['progress', determinate ? '' : 'progress-indeterminate', className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(clamped * 100) : undefined}
    >
      <div className="progress-fill" style={determinate ? { transform: `scaleX(${clamped})` } : undefined} />
    </div>
  )
}
