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
          // the flash it is meant to prevent.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.classList.toggle('dark',t!=='light');}catch(e){document.documentElement.classList.add('dark');}})();`,
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
