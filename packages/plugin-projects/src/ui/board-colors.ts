import { BOARD_COLORS, type BoardColor } from "@kanbaner/plugin-tasks/contract";

/**
 * Client-safe представление палитры доски и колонок.
 *
 * Домен хранит только имя цвета из `BOARD_COLORS`. Здесь имя превращается в
 * фиксированные классы темы; произвольные CSS/HEX из данных никогда не
 * применяются. `default` и отсутствие цвета дают прежнее оформление доски.
 */
export interface BoardColorOption {
  readonly value: BoardColor;
  readonly label: string;
  /** Класс цветного кружка для кнопок палитры. */
  readonly swatchClassName: string;
}

interface BoardColorSurface {
  /** Мягкий фон всей доски. */
  readonly boardClassName: string;
  /** Градиент правого fade-указателя прокрутки под фон доски. */
  readonly boardFadeClassName: string;
  /** Более заметный фон колонки. */
  readonly columnClassName: string;
}

const BOARD_COLOR_LABELS: Readonly<Record<BoardColor, string>> = {
  default: "По умолчанию",
  slate: "Серый",
  blue: "Синий",
  green: "Зелёный",
  yellow: "Жёлтый",
  orange: "Оранжевый",
  red: "Красный",
  purple: "Фиолетовый",
};

/**
 * Единственная таблица оформления.
 *
 * Классы записаны целыми строками, чтобы Tailwind находил их при сканировании
 * `packages/plugin-projects/src`. Пары light/dark подобраны так, чтобы
 * стандартные токены текста и контролов оставались читаемыми.
 */
const BOARD_COLOR_SURFACES: Readonly<Record<BoardColor, BoardColorSurface>> = {
  default: {
    boardClassName: "bg-[#e2e8f0] dark:bg-[#1e293b]",
    boardFadeClassName: "from-[#e2e8f0] dark:from-[#1e293b]",
    columnClassName: "bg-[#f1f5f9] dark:bg-[#263244]",
  },
  slate: {
    boardClassName: "bg-[#e8ebf0] dark:bg-[#1c222b]",
    boardFadeClassName: "from-[#e8ebf0] dark:from-[#1c222b]",
    columnClassName: "bg-[#dbe1e9] dark:bg-[#2a3340]",
  },
  blue: {
    boardClassName: "bg-[#e7eff9] dark:bg-[#172433]",
    boardFadeClassName: "from-[#e7eff9] dark:from-[#172433]",
    columnClassName: "bg-[#d7e5f6] dark:bg-[#20344c]",
  },
  green: {
    boardClassName: "bg-[#e8f3ec] dark:bg-[#16261d]",
    boardFadeClassName: "from-[#e8f3ec] dark:from-[#16261d]",
    columnClassName: "bg-[#d9ecdf] dark:bg-[#213c2b]",
  },
  yellow: {
    boardClassName: "bg-[#f7f2e2] dark:bg-[#292517]",
    boardFadeClassName: "from-[#f7f2e2] dark:from-[#292517]",
    columnClassName: "bg-[#f1e5c5] dark:bg-[#3a311d]",
  },
  orange: {
    boardClassName: "bg-[#faefe4] dark:bg-[#2a2119]",
    boardFadeClassName: "from-[#faefe4] dark:from-[#2a2119]",
    columnClassName: "bg-[#f6dfcb] dark:bg-[#3d2c1e]",
  },
  red: {
    boardClassName: "bg-[#f9eaea] dark:bg-[#2b1c1f]",
    boardFadeClassName: "from-[#f9eaea] dark:from-[#2b1c1f]",
    columnClassName: "bg-[#f4dada] dark:bg-[#42252a]",
  },
  purple: {
    boardClassName: "bg-[#f2ecf9] dark:bg-[#231d2d]",
    boardFadeClassName: "from-[#f2ecf9] dark:from-[#231d2d]",
    columnClassName: "bg-[#e7ddf4] dark:bg-[#342a44]",
  },
};

const SWATCH_CLASS_NAMES: Readonly<Record<BoardColor, string>> = {
  default: "bg-[#cbd5e1] dark:bg-[#475569]",
  slate: "bg-slate-400 dark:bg-slate-500",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  orange: "bg-orange-500",
  red: "bg-red-500",
  purple: "bg-violet-500",
};

/** Палитра в порядке контракта; доступна с клавиатуры обычными кнопками. */
export const BOARD_COLOR_OPTIONS: readonly BoardColorOption[] = BOARD_COLORS.map((value) => ({
  value,
  label: BOARD_COLOR_LABELS[value],
  swatchClassName: SWATCH_CLASS_NAMES[value],
}));

/**
 * Приводит неизвестное значение из данных к безопасному имени палитры.
 *
 * Всё, что не входит в `BOARD_COLORS` (старое значение, HEX, CSS, мусор),
 * трактуется как `default` и не попадает в стили.
 */
export function resolveBoardColor(value: unknown): BoardColor {
  return typeof value === "string" && (BOARD_COLORS as readonly string[]).includes(value)
    ? (value as BoardColor)
    : "default";
}

/** Русское имя цвета для текстовых/доступных названий. */
export function boardColorLabel(value: BoardColor | undefined): string {
  return BOARD_COLOR_LABELS[resolveBoardColor(value)];
}

/** Классы фона доски/fade для выбранного цвета. */
export function boardColorSurface(value: BoardColor | undefined): BoardColorSurface {
  return BOARD_COLOR_SURFACES[resolveBoardColor(value)];
}

/** Класс цветного кружка палитры. */
export function boardColorSwatchClassName(value: BoardColor): string {
  return SWATCH_CLASS_NAMES[resolveBoardColor(value)];
}
