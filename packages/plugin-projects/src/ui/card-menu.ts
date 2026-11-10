/** Геометрия, достаточная для позиционирования всплывающего меню. */
export interface MenuRect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface MenuViewport {
  readonly width: number;
  readonly height: number;
}

export interface MenuPosition {
  readonly top: number;
  readonly left: number;
  /** `top` — меню раскрыто вверх, `bottom` — вниз от кнопки. */
  readonly placement: "top" | "bottom";
}

/** Отступ от края viewport и зазор между кнопкой и меню. */
const MARGIN = 8;
const GAP = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Считает fixed-позицию меню относительно кнопки.
 *
 * Меню раскрывается вниз, если внизу достаточно места, иначе вверх. Итоговые
 * координаты всегда остаются внутри viewport: длинное меню прижимается к
 * нижнему краю, а широкое — к горизонтальным краям.
 */
export function computeMenuPosition(
  trigger: MenuRect,
  menuWidth: number,
  menuHeight: number,
  viewport: MenuViewport,
): MenuPosition {
  const spaceBelow = viewport.height - trigger.bottom - MARGIN;
  const spaceAbove = trigger.top - MARGIN;
  const needed = menuHeight + GAP;
  const placement: MenuPosition["placement"] =
    needed > spaceBelow && spaceAbove > spaceBelow ? "top" : "bottom";

  const rawTop = placement === "top" ? trigger.top - menuHeight - GAP : trigger.bottom + GAP;
  const top = clamp(rawTop, MARGIN, viewport.height - menuHeight - MARGIN);
  const left = clamp(trigger.right - menuWidth, MARGIN, viewport.width - menuWidth - MARGIN);

  return { top, left, placement };
}
