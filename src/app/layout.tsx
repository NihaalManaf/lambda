import type { Metadata } from "next";
import { STIX_Two_Text, Manrope, Inconsolata, Kalam } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import DesktopBridge from "@/components/desktop/DesktopBridge";

const stix = STIX_Two_Text({ subsets: ["latin"], variable: "--font-stix", style: ["normal", "italic"] });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const inconsolata = Inconsolata({ subsets: ["latin"], variable: "--font-inconsolata" });
const kalam = Kalam({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-kalam" });

export const metadata: Metadata = {
  title: "lambda",
  description: "design, review and verify — before the agents build",
};

// runs before first paint: electron's user agent carries "lambda-desktop" → html.desktop (title-bar css).
// "#boot" = first load straight from the launch splash: the page fades in once, already settled
// (html.boot skips the hero's entrance stagger), and the hash is dropped before React sees the URL.
// Window focus/blur dimming comes from the native window via the preload (html.blurred).
const DESKTOP_SNIPPET = `(function(){var d=document.documentElement;if(!/lambda-desktop/.test(navigator.userAgent))return;d.classList.add("desktop");if(location.hash==="#boot"){d.classList.add("boot");history.replaceState(history.state,"",location.pathname+location.search);setTimeout(function(){d.classList.remove("boot")},1400)}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: the mac app adds html.desktop before hydration (see script below)
    <html
      lang="en"
      suppressHydrationWarning
      className={`${stix.variable} ${manrope.variable} ${inconsolata.variable} ${kalam.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_SNIPPET }} />
      </head>
      <body className="min-h-dvh">
        <DesktopBridge />
        <header className="app-titlebar sticky top-0 z-40 border-b border-line/70 bg-paper/80 backdrop-blur-md">
          <nav className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
            <Link href="/" className="display text-2xl">
              λ lambda
            </Link>
            <div className="no-scrollbar flex min-w-0 items-center gap-4 overflow-x-auto text-sm text-ink-2 sm:gap-6">
              <Link href="/features" className="hover:text-ink">
                features
              </Link>
              <Link href="/sources" className="hover:text-ink">
                sources
              </Link>
              <Link href="/settings" className="hover:text-ink">
                settings
              </Link>
            </div>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
