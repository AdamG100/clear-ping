import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image is built with NEXT_OUTPUT=standalone, which produces a
  // self-contained server (.next/standalone) carrying only the modules it
  // uses. Left off otherwise, because `npm start` does not serve that output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,

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
