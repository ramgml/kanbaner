"use client";

import { useCallback, useSyncExternalStore } from "react";

function getMatchMedia(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }

  return window.matchMedia(query);
}

/**
 * Подписка на media query без layout-зависимостей.
 *
 * На сервере и в окружениях без `matchMedia` возвращается `false`; фактическое
 * значение читается после монтирования, поэтому SSR- и клиентский первый
 * рендер совпадают.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const mediaQuery = getMatchMedia(query);

      if (mediaQuery === null) {
        return () => undefined;
      }

      mediaQuery.addEventListener("change", onChange);

      return () => {
        mediaQuery.removeEventListener("change", onChange);
      };
    },
    [query],
  );

  const getSnapshot = useCallback((): boolean => getMatchMedia(query)?.matches ?? false, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
