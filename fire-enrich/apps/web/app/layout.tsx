import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { Roboto_Mono } from "next/font/google";
import ColorStyles from "@/components/shared/color-styles/color-styles";
import Scrollbar from "@/components/ui/scrollbar";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/app/sidebar/AppSidebar";
import "@/styles/main.css";

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-roboto-mono",
});

export const metadata: Metadata = {
  title: "Fire Enrich v2",
  description: "Enrich your data with AI-powered insights",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <ColorStyles />
      </head>
      <body
        className={`${GeistMono.variable} ${robotoMono.variable} font-sans text-accent-black bg-background-base overflow-x-clip`}
      >
        <div className="flex min-h-svh w-full">
          <AppSidebar />
          <main className="min-w-0 flex-1 overflow-x-clip">{children}</main>
        </div>
        <Scrollbar />
        <Toaster />
      </body>
    </html>
  );
}
