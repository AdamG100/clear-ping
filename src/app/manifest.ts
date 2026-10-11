import type { MetadataRoute } from 'next'
import { SPLASH_BACKGROUND, THEME_COLOR } from '@/lib/app-theme'

/**
 * What a phone or a desktop browser needs to install ClearPing as an app: its
 * name, its icons, and that it opens in a window of its own. Served as
 * `/manifest.webmanifest` and linked from every page.
 *
 * The manifest can name one colour, not one per theme, so it names the dark
 * theme's: the one the icon is drawn in. Once the app is open, the bars follow
 * the theme in use (the `themeColor` in the layout).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'ClearPing',
    short_name: 'ClearPing',
    description: 'Smokeping-style latency and packet loss monitoring',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: SPLASH_BACKGROUND,
    theme_color: THEME_COLOR.dark,
    categories: ['utilities', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Drawn with a margin, for Android to cut to whatever shape its launcher uses.
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  }
}
