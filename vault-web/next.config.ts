import path from "node:path";
import type { NextConfig } from "next";

// Content-Security-Policy: the browser itself enforces "this site talks to
// nobody else". Scripts, styles, fonts, images and requests may only come from
// the site (plus in-memory data:/blob: for QR codes). Even a script that somehow
// got injected couldn't send a bid to another server with fetch, an image or a
// form. 'unsafe-inline' is what Next.js needs for its own inline bootstrap
// scripts and for style attributes.
const dev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  // vault-core is shipped as TypeScript source from the sibling folder.
  transpilePackages: ["vault-core"],
  turbopack: { root: path.join(__dirname, "..") },
  outputFileTracingRoot: path.join(__dirname, ".."),
  poweredByHeader: false,
  // The development server keeps no cache on disk between runs. With one, a
  // cache left over from before the code was updated made the server lose
  // track of routes (it answered "not found" for pages that exist) until the
  // .next folder was deleted. Starting clean each time costs a few seconds.
  experimental: { turbopackFileSystemCacheForDev: false },
  // Let the dev server work when opened as http://127.0.0.1:3100 as well as localhost.
  allowedDevOrigins: ["127.0.0.1"],
  // Privacy headers: no referrer leaks to other sites, no embedding, no
  // browser features we don't use, no MIME sniffing, and a Content-Security-Policy.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default config;
