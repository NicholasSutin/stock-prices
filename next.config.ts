import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Enables getCloudflareContext() during `next dev`.
// https://opennext.js.org/cloudflare/bindings#local-access-to-bindings
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  devIndicators: false,
};

export default nextConfig;
