import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TD-3-SR — Analog Bass Line Synthesizer",
  description:
    "Émulation Web Audio du Behringer TD-3-SR : VCO, VCF résonant, séquenceur 16 pas, accent, slide et distortion.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#1a1a1c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
