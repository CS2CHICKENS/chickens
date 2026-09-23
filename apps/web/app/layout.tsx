import type { Metadata, Viewport } from "next";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "./globals.css";
import { Shell } from "../components/game";
const assets = process.env.NEXT_PUBLIC_ASSET_BASE || "/img";
export const metadata: Metadata = {
  applicationName: "CS2 Chickens",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: assets + "/brand-favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: assets + "/brand-icon-32.png", type: "image/png", sizes: "32x32" },
      {
        url: assets + "/brand-icon-192.png",
        type: "image/png",
        sizes: "192x192",
      },
    ],
    apple: [{ url: assets + "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { title: "CS2 Chickens" },
  twitter: {
    site: "@CS2Chickens",
    card: "summary_large_image",
    images: [assets + "/brand-social.png"],
  },
  metadataBase: new URL("https://cs2chickens.fun"),
  title: {
    default: "CS2 Chickens | The family race",
    template: "%s | CS2 Chickens",
  },
  description: "Three families. One round. Every hatch verifiable.",
  openGraph: {
    siteName: "CS2 Chickens",
    images: [
      {
        url: assets + "/brand-social.png",
        width: 1200,
        height: 630,
        alt: "CS2 Chickens",
      },
    ],
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#101215",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
