/**
 * OpenAI 兼容生图 URL 与响应解析。全程 mock fetch，不访问真实中转站。
 */

import { describe, expect, it } from "vitest";
import {
  editImagePng,
  generateImagePng,
  OpenAiImagesError,
  resolveOpenAiImagesUrl,
} from "../src/main/image-gen/openai-images";
import { IMAGE_GEN_TEST_PROMPT } from "../src/main/image-gen/settings";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const API_KEY = "sk-test-image-key-should-not-leak";

function pngResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveOpenAiImagesUrl", () => {
  it("裸域名补上 /v1/images/generations", () => {
    expect(resolveOpenAiImagesUrl("https://api.example.com", "generations")).toBe(
      "https://api.example.com/v1/images/generations",
    );
  });

  it("已经以 /v1 结尾时不再拼一次 /v1", () => {
    expect(resolveOpenAiImagesUrl("https://api.example.com/v1/", "generations")).toBe(
      "https://api.example.com/v1/images/generations",
    );
    expect(resolveOpenAiImagesUrl("https://relay.example/openai/v1", "edits")).toBe(
      "https://relay.example/openai/v1/images/edits",
    );
  });

  it("已经是完整路径时原样使用，改图只换最后一段", () => {
    expect(
      resolveOpenAiImagesUrl("https://relay.example/v1/images/generations", "generations"),
    ).toBe("https://relay.example/v1/images/generations");
    expect(resolveOpenAiImagesUrl("https://relay.example/v1/images/generations/", "edits")).toBe(
      "https://relay.example/v1/images/edits",
    );
  });

  it("去掉地址里的用户名和密码", () => {
    expect(resolveOpenAiImagesUrl("https://user:secret@api.example.com/v1", "generations")).toBe(
      "https://api.example.com/v1/images/generations",
    );
  });
});

describe("generateImagePng / editImagePng", () => {
  it("生成请求带短提示词，密钥只在 Authorization，响应当 PNG 字节", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      seenBody = String(init?.body);
      return pngResponse();
    };
    const bytes = await generateImagePng({
      baseUrl: "https://relay.example/v1",
      apiKey: API_KEY,
      model: "gpt-image-2",
      prompt: IMAGE_GEN_TEST_PROMPT,
      fetchImpl,
    });
    expect(seenUrl).toBe("https://relay.example/v1/images/generations");
    expect(seenAuth).toBe(`Bearer ${API_KEY}`);
    expect(seenBody).toContain(IMAGE_GEN_TEST_PROMPT);
    expect(seenBody).not.toContain(API_KEY);
    expect(bytes[0]).toBe(0x89);
    expect(Buffer.from(bytes).toString("utf8")).not.toContain(API_KEY);
  });

  it("失败原因不含密钥", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: `rejected ${API_KEY}` } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    await expect(
      generateImagePng({
        baseUrl: "https://relay.example/v1/images/generations",
        apiKey: API_KEY,
        model: "gpt-image-2",
        prompt: IMAGE_GEN_TEST_PROMPT,
        fetchImpl,
      }),
    ).rejects.toThrow(OpenAiImagesError);
    try {
      await generateImagePng({
        baseUrl: "https://relay.example/v1/images/generations",
        apiKey: API_KEY,
        model: "gpt-image-2",
        prompt: IMAGE_GEN_TEST_PROMPT,
        fetchImpl,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAiImagesError);
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(API_KEY);
      expect(message).toContain("已脱敏");
    }
  });

  it("edits 提交原图字节并返回 PNG，不把密钥写进表单", async () => {
    const source = Uint8Array.from(Buffer.from(PNG_B64, "base64"));
    let seenUrl = "";
    let contentType: string | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      contentType = new Headers(init?.headers).get("content-type");
      const form = init?.body;
      expect(form).toBeInstanceOf(FormData);
      const fields = form as FormData;
      expect(fields.get("prompt")).toBe("add a hat");
      expect(fields.get("model")).toBe("gpt-image-2");
      expect(fields.get("image")).toBeInstanceOf(Blob);
      expect(JSON.stringify([...fields.entries()])).not.toContain(API_KEY);
      return pngResponse();
    };
    const bytes = await editImagePng({
      baseUrl: "https://relay.example/v1/images/generations",
      apiKey: API_KEY,
      model: "gpt-image-2",
      prompt: "add a hat",
      imagePng: source,
      fetchImpl,
    });
    expect(seenUrl).toBe("https://relay.example/v1/images/edits");
    expect(contentType).toBeNull();
    expect(bytes[0]).toBe(0x89);
  });
});
