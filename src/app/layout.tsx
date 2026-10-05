import type { Metadata } from "next";
import { Instrument_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";

// Instrument Sans: a slightly condensed technical grotesque — reads like
// equipment labelling rather than another product-dashboard Inter.
const instrumentSans = Instrument_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

// Every reading in this app is a number being compared to another number, so
// the mono face carries all of them, with tabular figures so digits do not
// shift as values change.
const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ClearPing — Network Monitoring",
  description: "Smokeping-style latency and packet loss monitoring",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: the inline script below sets the theme class
    // before React hydrates, so the server and client markup differ by design.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // Applies the saved theme before first paint. Without this the page
          // renders in the default theme and then snaps, which is worse than
          // the flash it is meant to prevent. It also notes whether a group
          // was left open rather than a target, so the loading placeholder
          // can take the right shape (see `.skeleton-target-only`).
          dangerouslySetInnerHTML={{
            __html: `(function(){var d=document.documentElement;try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}d.classList.toggle('dark',t!=='light');if(localStorage.getItem('selectedGroup'))d.dataset.view='group';}catch(e){d.classList.add('dark');}})();`,
          }}
        />
      </head>
      <body
        className={`${instrumentSans.variable} ${plexMono.variable} antialiased bg-background text-foreground`}
      >
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
