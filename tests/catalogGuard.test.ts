import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const typesSource = readFileSync(path.join(root, "types.ts"), "utf-8");
const constantsSource = readFileSync(path.join(root, "constants.ts"), "utf-8");

// Danh mục thể loại/giọng/kết cấu tồn tại ở hai nơi (union type trong types.ts và mảng
// trong constants.ts). Test này khóa chúng phải khớp hệt nhau — lệch là CI đỏ.
const extractUnion = (source: string, typeName: string): string[] => {
  const match = source.match(new RegExp(`export type ${typeName}\\s*=([^;]+);`, "s"));
  if (!match) throw new Error(`Không tìm thấy union type ${typeName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
};

const extractArray = (source: string, constName: string): string[] => {
  const match = source.match(new RegExp(`export const ${constName}[^=]*=\\s*\\[([^\\]]+)\\]`, "s"));
  if (!match) throw new Error(`Không tìm thấy mảng ${constName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
};

describe("danh mục types.ts ↔ constants.ts không được lệch", () => {
  const cases: Array<[string, string]> = [
    ["Genre", "GENRES"],
    ["Tone", "TONES"],
    ["StoryMode", "MODES"],
  ];
  for (const [typeName, constName] of cases) {
    it(`${typeName} khớp ${constName}`, () => {
      const union = extractUnion(typesSource, typeName);
      const array = extractArray(constantsSource, constName);
      expect(new Set(array).size).toBe(array.length); // không trùng trong mảng
      expect([...array].sort()).toEqual([...union].sort());
    });
  }
});
