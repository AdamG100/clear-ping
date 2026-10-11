import { cn } from '@/lib/utils'

/** The mark is a miniature trace: the thing the product makes. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent',
        className
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 20 14" className="h-4 w-5" fill="none">
        <path
          d="M1 9 L4 8 L7 10 L10 3 L13 7 L16 6 L19 6.5"
          stroke="var(--signal-perfect)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
