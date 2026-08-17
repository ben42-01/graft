"use client";

/**
 * Wires `next-themes`' class switcher to the `.dark` selector globals.css
 * already keys every token off (GRAFT-11.1). Nothing toggled that class
 * before this issue — see the comment at the top of globals.css.
 */
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem {...props}>
      {children}
    </NextThemesProvider>
  );
}
