/**
 * How the main pane is laid out, shared by every page shown in it.
 *
 * The pane sits beside a sidebar on a wide screen and fills the screen on a
 * narrow one, so the width of the screen says little about the room a page
 * has. Everything inside the pane is sized from the pane itself: `<main>` is
 * the `main` container, and the `@…/main:` variants below, and in the
 * components the pane holds, answer to its width.
 */

/**
 * The frame of a page: tighter on a phone, and held to a readable width on a
 * very wide monitor, where a chart stretched across all of it is a ribbon.
 */
export const PANE = 'mx-auto w-full max-w-[100rem] space-y-4 p-4 @2xl/main:space-y-6 @2xl/main:p-6'

/** A page's title and its controls: stacked until there is room for both on one line. */
export const PANE_HEADER =
  'flex flex-col gap-4 @4xl/main:flex-row @4xl/main:items-center @4xl/main:justify-between'

/** The controls beside a title. Too narrow for one line, they wrap and the buttons share the second. */
export const PANE_ACTIONS = 'flex flex-wrap items-center gap-2 @xl/main:flex-nowrap @xl/main:gap-3'

/** A button among those controls: half of the wrapped line, or its own width once they fit on one. */
export const PANE_ACTION = 'flex-1 shrink-0 @xl/main:flex-none'

export const PANE_TITLE = 'break-words text-xl font-semibold tracking-tight text-foreground @2xl/main:text-2xl'
