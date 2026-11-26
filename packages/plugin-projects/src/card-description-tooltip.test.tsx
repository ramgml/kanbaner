import { describe, expect, it } from "vitest";

import {
  computeCardDescriptionTooltipPosition,
  descriptionPreview,
} from "./ui/card-description-tooltip.tsx";

describe("descriptionPreview", () => {
  it("сохраняет текст и абзацы, а пустое описание скрывает", () => {
    expect(descriptionPreview("## Заголовок\n\nОписание")).toBe("## Заголовок\n\nОписание");
    expect(descriptionPreview(" \n ")).toBe("");
  });

  it("сохраняет длинное описание целиком для прокрутки", () => {
    const description = "я".repeat(599) + "😀" + "хвост";

    expect(descriptionPreview(description)).toBe(description);
  });
});

describe("computeCardDescriptionTooltipPosition", () => {
  it("выбирает верх, а при нехватке места переворачивается вниз", () => {
    const anchor = { top: 200, bottom: 260, left: 100, width: 200 };
    const tooltip = { width: 300, height: 100 };
    const viewport = { width: 800, height: 600 };

    expect(computeCardDescriptionTooltipPosition(anchor, tooltip, viewport)).toEqual({
      top: 92,
      left: 50,
      placement: "top",
    });
    expect(
      computeCardDescriptionTooltipPosition({ ...anchor, top: 80, bottom: 140 }, tooltip, viewport),
    ).toEqual({ top: 148, left: 50, placement: "bottom" });
  });

  it("ограничивает координаты краями малого viewport", () => {
    const position = computeCardDescriptionTooltipPosition(
      { top: 10, bottom: 40, left: 340, width: 50 },
      { width: 350, height: 240 },
      { width: 360, height: 280 },
    );

    expect(position.left).toBe(8);
    expect(position.top).toBe(8);
    expect(position.top + 240).toBeLessThanOrEqual(272);
  });
});
