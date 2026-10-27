/**
 * The app's colours for the places a stylesheet cannot reach: the browser's
 * own bars, the installed app's title bar, and the screen shown while it
 * starts. Those are told a colour as a plain hex value, in the manifest and in
 * a meta tag, so these are copies of tokens in `src/app/globals.css` and have
 * to be changed along with them.
 */

/** `--surface`, which the sidebar and the bar across the top of a phone's screen are drawn in. */
export const THEME_COLOR = {
  light: '#ffffff',
  dark: '#141719',
} as const

/** `--background` in the dark theme, behind the icon while the installed app starts. */
export const SPLASH_BACKGROUND = '#0b0c0d'
