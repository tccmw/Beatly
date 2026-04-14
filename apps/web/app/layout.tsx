import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beatly",
  description: "Drum sheet and lyric alignment from MP3 uploads",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
