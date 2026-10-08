import type { Metadata } from "next";

// The form on this page runs in the browser, so its tab title is set here.
export const metadata: Metadata = { title: "Create A Deal" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
