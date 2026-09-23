import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next",
  agentRules: false,
  devIndicators: false,
  trailingSlash: true,
  images: { unoptimized: true },
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
};
export default config;
