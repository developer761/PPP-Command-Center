"use client";

import { createContext, useContext } from "react";
import type { Viewer } from "@/lib/auth/viewer";

/**
 * Provides the resolved Viewer to client components (topbar switcher,
 * sidebar Links, etc.). Server components should call resolveViewer()
 * directly instead of reading this context.
 */
const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: Viewer | null;
  children: React.ReactNode;
}) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

/**
 * Read the current viewer. Returns null if rendered outside a provider
 * or before the layout has resolved auth — callers should guard for null.
 */
export function useViewer(): Viewer | null {
  return useContext(ViewerContext);
}
