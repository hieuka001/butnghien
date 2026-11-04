import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const clientSource = readFileSync(path.join(root, "services/geminiService.ts"), "utf-8");
const apiSource = readFileSync(path.join(root, "api/gemini.ts"), "utf-8");

// Tầng key-pool/model tồn tại ở cả client (services/geminiService.ts) và proxy
// (api/gemini.ts) — Vercel function không import được file ngoài api/ nên chưa gộp được
// một nguồn. Test này là lưới chống drift: các hằng số sống còn lệch nhau là CI đỏ.
const extractModelMap = (source: string): Record<string, string> => {
  const start = source.indexOf("deprecatedModelMap");
  if (start === -1) throw new Error("Không tìm thấy deprecatedModelMap");
  const block = source.slice(start, source.indexOf("};", start));
  const entries: Record<string, string> = {};
  for (const match of block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)) {
    entries[match[1]] = match[2];
  }
  // Một số giá trị là DEFAULT_GEMINI_MODEL thay vì chuỗi literal — chuẩn hóa về tên model mặc định.
  for (const match of block.matchAll(/"([^"]+)":\s*DEFAULT_GEMINI_MODEL/g)) {
    entries[match[1]] = "__DEFAULT__";
  }
  return entries;
};

const extractRoleConfig = (source: string, name: "offsets" | "sizes"): Record<string, number> => {
  const match = source.match(new RegExp(`const ${name}: Record<[^>]+> = \\{([^}]+)\\}`));
  if (!match) throw new Error(`Không tìm thấy ${name}`);
  const entries: Record<string, number> = {};
  for (const pair of match[1].matchAll(/(\w+):\s*(\d+)/g)) {
    entries[pair[1]] = Number(pair[2]);
  }
  return entries;
};

describe("drift-guard client ↔ api/gemini.ts", () => {
  it("model mặc định giống nhau", () => {
    const clientDefault = clientSource.match(/const DEFAULT_GEMINI_MODEL = "([^"]+)"/)?.[1];
    const apiDefault = apiSource.match(/const DEFAULT_GEMINI_MODEL = "([^"]+)"/)?.[1];
    expect(clientDefault).toBeTruthy();
    expect(apiDefault).toEqual(clientDefault);
  });

  it("bản đồ model cũ (deprecatedModelMap) giống hệt nhau", () => {
    expect(extractModelMap(apiSource)).toEqual(extractModelMap(clientSource));
  });

  it("offset/cỡ kho key theo vai (getGeminiKeysForRole) giống hệt nhau", () => {
    expect(extractRoleConfig(apiSource, "offsets")).toEqual(extractRoleConfig(clientSource, "offsets"));
    expect(extractRoleConfig(apiSource, "sizes")).toEqual(extractRoleConfig(clientSource, "sizes"));
    expect(extractRoleConfig(clientSource, "offsets")).toEqual({ writer: 0, reviewer: 1, rewriter: 2, direction: 0 });
    expect(extractRoleConfig(clientSource, "sizes")).toEqual({ writer: 2, reviewer: 2, rewriter: 2, direction: 1 });
  });

  it("keyFingerprint cùng thuật toán djb2 (hằng 5381) ở cả hai nơi", () => {
    expect(clientSource).toContain("5381");
    expect(apiSource).toContain("5381");
  });

  it("gemini-3.8-flash không nằm trong chuỗi fallback mặc định của proxy (chỉ qua env bật rõ)", () => {
    const start = apiSource.indexOf("const defaultFallbacks");
    const block = apiSource.slice(start, apiSource.indexOf("];", start));
    expect(block).toContain("GEMINI_ALLOW_SCARCE_FALLBACK");
    // Bỏ comment và dòng spread có điều kiện env, phần còn lại không được chứa literal của model khan hiếm.
    const withoutOptIn = block
      .split("\n")
      .filter(line => !line.trim().startsWith("//") && !line.includes("GEMINI_ALLOW_SCARCE_FALLBACK"))
      .join("\n");
    expect(withoutOptIn).not.toContain("gemini-3.8-flash");
  });
});
