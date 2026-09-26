import type { Metadata } from "next";
import { Cinzel, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
// Display face echoing the emblem's inscriptional capitals; used for headings only.
const cinzel = Cinzel({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-cinzel", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Token Samurai · Crypto Research", template: "%s · Token Samurai" },
  description: "Token Samurai — AI-powered crypto market intelligence and fundamentals research. Cut through the noise. Find the signal.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${cinzel.variable}`}>
      <body>{children}</body>
    </html>
  );
}
