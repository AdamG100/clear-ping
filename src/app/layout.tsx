import type { Metadata, Viewport } from "next";
import { Instrument_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { THEME_COLOR } from "@/lib/app-theme";
import { InstallPrompt } from "./_components/install-prompt";
import { ServiceWorker } from "./_components/service-worker";

// Instrument Sans: a slightly condensed technical grotesque — reads like
// equipment labelling rather than another product-dashboard Inter.
//
// The two faces are handed to the stylesheet under names of their own, and
// globals.css makes them Tailwind's `--font-sans` and `--font-mono`. Named
// `--font-sans` here, the theme's `--font-sans: var(--font-sans)` defined the
// variable as itself, which is no value at all: the page fell back to the
// system's font and this one was never so much as downloaded.
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  display: "swap",
});

// Every reading in this app is a number being compared to another number, so
// the mono face carries all of them, with tabular figures so digits do not
// shift as values change.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ClearPing — Network Monitoring",
  description: "Smokeping-style latency and packet loss monitoring",
  // Installed to a phone's home screen (see manifest.ts): the name under the
  // icon, and on iOS, which reads these instead of the manifest, the icon.
  // The status bar is left as iOS draws it. The translucent style puts white
  // text over the page, which is unreadable on the light theme.
  applicationName: "ClearPing",
  appleWebApp: { capable: true, title: "ClearPing", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
  // A phone takes any run of digits and dots for a telephone number and makes
  // a link of it. Most of what this app shows is IP addresses.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Drawn out to the edges of the screen, under a notch and the home
  // indicator, with the page keeping its own contents clear of them (the
  // `--safe-*` values in globals.css). Left to the browser, a phone on its
  // side gets a blank bar down each edge.
  viewportFit: "cover",
  // The page shrinks to what is left above an on-screen keyboard, so a dialog
  // stays centred in what can be seen and its last field can be scrolled to.
  interactiveWidget: "resizes-content",
  // The colour of the browser's own bars, and of the installed app's, matched
  // to the bar across the top of the page so the two read as one.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: the inline script below sets the theme class
    // before React hydrates, so the server and client markup differ by design.
    // The fonts are named on the root element, not on <body>: that is where
    // the theme's variables are worked out, and what the page's own font is
    // taken from.
    <html lang="en" className={`${instrumentSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script
          // Applies the saved theme before first paint. Without this the page
          // renders in the default theme and then snaps, which is worse than
          // the flash it is meant to prevent. It also notes whether a group
          // was left open rather than a target, so the loading placeholder
          // can take the right shape (see `.skeleton-target-only`), and
          // whether the sidebar was collapsed, so it is not drawn and then
          // taken away (see `sidebar-collapsed` in globals.css).
          dangerouslySetInnerHTML={{
            __html: `(function(){var d=document.documentElement;try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}d.classList.toggle('dark',t!=='light');if(localStorage.getItem('selectedGroup'))d.dataset.view='group';if(localStorage.getItem('sidebarCollapsed'))d.dataset.sidebar='collapsed';}catch(e){d.classList.add('dark');}})();`,
          }}
        />
        <script
          // Keeps the browser's offer to install the app (Android), which it
          // makes once and may make before any of the page's own code has
          // loaded. Holding it is also what stops Chrome showing a bar of its
          // own, so the offer is made in one place: `InstallPrompt` below,
          // which is told through the event that there is something to show.
          dangerouslySetInnerHTML={{
            __html: `(function(){function c(){window.dispatchEvent(new Event('installpromptchange'))}window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__installPrompt=e;c()});window.addEventListener('appinstalled',function(){window.__installPrompt=null;c()})})();`,
          }}
        />
      </head>
      <body className="antialiased bg-background text-foreground">
        <ToastProvider>{children}</ToastProvider>
        <InstallPrompt />
        <ServiceWorker />
      </body>
    </html>
  );
}
