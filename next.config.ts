import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // An unrelated lockfile in a parent directory makes Next guess the wrong
  // workspace root; pin it to this repo.
  outputFileTracingRoot: import.meta.dirname,
  // Security headers get their full treatment with the auth contract; these are
  // the baseline that costs nothing to have from commit one (docs/BACKEND.md §4).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
