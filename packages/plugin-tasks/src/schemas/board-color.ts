import { Type } from "@sinclair/typebox";

/**
 * Фиксированная палитра оформления проекта и колонок.
 *
 * Произвольные HEX/CSS-значения в контракт не входят: представление само
 * сопоставляет имя цвета с токенами темы.
 */
export const BOARD_COLORS = [
  "default",
  "slate",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
] as const;

export type BoardColor = (typeof BOARD_COLORS)[number];

/** Цвет доски или колонки из общей палитры. */
export const BoardColorSchema = Type.Union(BOARD_COLORS.map((color) => Type.Literal(color)));
