import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { env } from "@/env";
import "./globals.css";

export const metadata: Metadata = {
  // Resolves relative OG/Twitter image URLs (GRAFT-10's opengraph-image
  // route) to an absolute one per environment, instead of Next's dev-only
  // localhost fallback.
  metadataBase: new URL(env().APP_URL),
  title: "Graft",
  description: "Graft together the business system that fits you.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
