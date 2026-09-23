import type { MetadataRoute } from "next";
export const dynamic = "force-static";
export default function manifest(): MetadataRoute.Manifest {
  const assets = process.env.NEXT_PUBLIC_ASSET_BASE || "/img";
  return {
    name: "CS2 Chickens",
    short_name: "CS2 Chickens",
    description: "Three families. One round. Every hatch verifiable.",
    start_url: "/",
    display: "browser",
    background_color: "#111316",
    theme_color: "#111316",
    icons: [
      {
        src: assets + "/brand-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: assets + "/brand-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: assets + "/brand-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
