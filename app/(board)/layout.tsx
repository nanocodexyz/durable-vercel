import type { ReactNode } from "react";

export default function BoardLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ background: "#0b0b0c", color: "#e8e8e8", fontFamily: "ui-monospace, monospace", margin: 0, padding: 24 }}>{children}</body>
    </html>
  );
}
