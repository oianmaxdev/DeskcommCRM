import { describe, expect, it } from "vitest";

import { middlewareDaAssinatura, paramsDaAssinatura } from "./modelo-da-assinatura";

type P = Parameters<typeof paramsDaAssinatura>[0];

describe("modelo pela assinatura do ChatGPT", () => {
  it("tira amostragem e teto de saída e liga store:false, preservando o resto", () => {
    const saida = paramsDaAssinatura({
      prompt: [],
      temperature: 0,
      maxOutputTokens: 8000,
      topP: 1,
      providerOptions: { openai: { reasoningEffort: "low" } },
    } as unknown as P) as unknown as Record<string, unknown>;
    expect(saida.temperature).toBeUndefined();
    expect(saida.maxOutputTokens).toBeUndefined();
    expect(saida.topP).toBeUndefined();
    expect(saida.prompt).toEqual([]);
    expect(saida.providerOptions).toEqual({ openai: { reasoningEffort: "low", store: false } });
  });

  it("chama em streaming e remonta texto, uso e motivo de parada", async () => {
    const partes = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "r1", modelId: "gpt-5.6-luna" },
      { type: "text-delta", id: "t", delta: '{"a":' },
      { type: "text-delta", id: "t", delta: "1}" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 3 } },
    ];
    let gerouSemStream = false;
    const r = (await middlewareDaAssinatura.wrapGenerate!({
      doGenerate: async () => {
        gerouSemStream = true;
        throw new Error("não deve");
      },
      doStream: async () => ({
        stream: new ReadableStream({ start(c) { partes.forEach((p) => c.enqueue(p)); c.close(); } }),
      }),
      params: {},
      model: {},
    } as never)) as unknown as { content: unknown; finishReason: string; response: Record<string, unknown> };
    expect(gerouSemStream).toBe(false);
    expect(r.content).toEqual([{ type: "text", text: '{"a":1}' }]);
    expect(r.finishReason).toBe("stop");
    expect(r.response.modelId).toBe("gpt-5.6-luna");
    expect(r.response.type).toBeUndefined();
  });

  it("erro dentro do stream sobe como erro (não vira resposta vazia)", async () => {
    await expect(
      middlewareDaAssinatura.wrapGenerate!({
        doGenerate: async () => ({}) as never,
        doStream: async () => ({
          stream: new ReadableStream({ start(c) { c.enqueue({ type: "error", error: new Error("429 limite") }); c.close(); } }),
        }),
        params: {},
        model: {},
      } as never),
    ).rejects.toThrow("429 limite");
  });
});
