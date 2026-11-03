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
    return [{ source: "/settings/probe-agents", destination: "/settings/probes", permanent: true }];
  },

  async headers() {
    return [
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
