/**
 * "Required" beside a field's label, so a field that has to be filled in is
 * told apart before anything is typed. Shown by the Arc fields (input,
 * textarea, password, select) whenever they are given `required`, which is
 * also what tells a screen reader, so the word itself is hidden from one.
 */
export function RequiredMark() {
  return (
    <span
      aria-hidden="true"
      className="ml-1.5 inline-flex translate-y-[-1px] items-center rounded-full border border-border bg-muted px-1.5 py-px align-middle text-[10px] font-medium leading-4 text-muted-foreground"
    >
      Required
    </span>
  )
}
