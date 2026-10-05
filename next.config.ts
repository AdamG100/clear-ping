import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image is built with NEXT_OUTPUT=standalone, which produces a
  // self-contained server (.next/standalone) carrying only the modules it
  // uses. Left off otherwise, because `npm start` does not serve that output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
