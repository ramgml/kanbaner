import { describe, expect, it } from "vitest";

import { computeMenuPosition, type MenuRect } from "./ui/card-menu.ts";

function rect(overrides: Partial<MenuRect> = {}): MenuRect {
  return {
    top: 100,
    left: 500,
    right: 530,
    bottom: 130,
    width: 30,
    height: 30,
    ...overrides,
  };
}

describe("computeMenuPosition", () => {
  it("раскрывает меню вниз под кнопкой, если места достаточно", () => {
    const position = computeMenuPosition(rect(), 240, 200, { width: 1024, height: 768 });

    expect(position.placement).toBe("bottom");
    expect(position.top).toBe(136);
    expect(position.left).toBe(290);
  });

  it("переворачивает меню вверх при нехватке места снизу", () => {
    const position = computeMenuPosition(rect({ top: 700, bottom: 730 }), 240, 300, {
      width: 1024,
      height: 768,
    });

    expect(position.placement).toBe("top");
    expect(position.top).toBe(394);
  });

  it("прижимает меню к нижнему и правому краю viewport", () => {
    const position = computeMenuPosition(
      rect({ top: 900, bottom: 930, left: 990, right: 1020 }),
      600,
      300,
      { width: 1024, height: 768 },
    );

    expect(position.placement).toBe("top");
    expect(position.top).toBe(460);
    expect(position.left).toBe(416);
  });

  it("не выпускает меню за левый/верхний край", () => {
    const position = computeMenuPosition(
      rect({ top: 4, left: 0, right: 20, bottom: 34 }),
      240,
      200,
      { width: 1024, height: 768 },
    );

    expect(position.placement).toBe("bottom");
    expect(position.top).toBe(40);
    expect(position.left).toBe(8);
  });

  it("меню выше viewport остаётся у верхнего отступа", () => {
    const position = computeMenuPosition(rect({ top: 740, bottom: 760 }), 240, 900, {
      width: 1024,
      height: 768,
    });

    expect(position.top).toBe(8);
  });
});
