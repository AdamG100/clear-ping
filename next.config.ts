import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image is built with NEXT_OUTPUT=standalone, which produces a
  // self-contained server (.next/standalone) carrying only the modules it
  // uses. Left off otherwise, because `npm start` does not serve that output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,

  // Nothing here uses next/image, and its /_next/image endpoint is an
  // attack surface of its own (it decodes whatever it is sent). Off, so the
  // endpoint is not there to be reached.
  images: { unoptimized: true },

  // Addresses that were renamed keep working, for bookmarks and for the
  // browser's history.
  async redirects() {
    return [
      { source: "/settings/probe-agents", destination: "/settings/probes", permanent: true },
      // Monitors were called targets.
      { source: "/targets/:path*", destination: "/monitors/:path*", permanent: true },
    ];
  },

  async headers() {
    return [
      {
        // Everywhere, the files the proxy does not see included. No other site
        // can load ClearPing in a frame, where clicks tricked out of someone
        // would count as made on ClearPing's own pages. The page's own policy
        // says the same in the proxy, with what only a request can decide.
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        // The service worker is never served from a cache, the browser's or a
        // proxy's in front of the app. A stale one keeps running on every
        // device that has the app installed, with no way to reach in and
        // replace it.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
