import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

describe("границы публичного SDK", () => {
  it("не импортирует kernel, apps, React или Tailwind", () => {
    const forbidden = [
      /@kanbaner\/kernel/,
      /(?:^|\n)\s*import[^;]*["']react["']/,
      /(?:^|\n)\s*import[^;]*["']react-dom["']/,
      /apps\//,
      /packages\/kernel/,
      /tailwindcss/,
    ];

    for (const file of sourceFiles(sourceDirectory)) {
      const source = readFileSync(file, "utf8");

      for (const pattern of forbidden) {
        expect(source, `${file} содержит запрещённый импорт ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("не использует explicit any в публичных исходниках", () => {
    for (const file of sourceFiles(sourceDirectory)) {
      const source = readFileSync(file, "utf8");

      expect(source, `${file} содержит any`).not.toMatch(/\bany\b/);
    }
  });
});
