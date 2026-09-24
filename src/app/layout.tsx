import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Katana | Crypto Fundamentals Research",
  description: "A research interface for stored crypto market and protocol fundamentals with explicit source provenance.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
