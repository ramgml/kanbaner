"use client";

import { useEffect, useId, useState, useSyncExternalStore, type ChangeEvent } from "react";

import {
  FONT_SCALE_DEFAULT,
  FONT_SCALE_OPTIONS,
  applyFontScale,
  normalizeFontScale,
  persistFontScale,
  readStoredFontScale,
  type FontScale,
} from "./font-scale";

function subscribeToFontScale(): () => void {
  // Кросс-вкладочная синхронизация не нужна: bootstrap и select читают один ключ.
  return () => {};
}

function getClientFontScale(): FontScale {
  return readStoredFontScale();
}

function getServerFontScale(): FontScale {
  return FONT_SCALE_DEFAULT;
}

export function FontSizeSetting() {
  const selectId = useId();
  const hintId = useId();
  const storedScale = useSyncExternalStore(
    subscribeToFontScale,
    getClientFontScale,
    getServerFontScale,
  );
  const [selectedScale, setSelectedScale] = useState<FontScale | null>(null);
  const scale = selectedScale ?? storedScale;

  // Bootstrap в root layout применяет сохранённое значение до первой отрисовки;
  // повторное применение нужно для dev-remount и монтирования вне root layout.
  useEffect(() => {
    applyFontScale(readStoredFontScale());
  }, []);

  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    const next = normalizeFontScale(event.target.value);
    setSelectedScale(next);
    applyFontScale(next);
    persistFontScale(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={selectId} className="text-sm font-medium">
        Размер шрифта
      </label>
      <select
        id={selectId}
        value={scale}
        onChange={handleChange}
        aria-describedby={hintId}
        className="h-8 w-full max-w-48 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {FONT_SCALE_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option}%
          </option>
        ))}
      </select>
      <p id={hintId} className="text-sm text-muted-foreground">
        Применяется сразу и сохраняется в этом браузере.
      </p>
    </div>
  );
}
