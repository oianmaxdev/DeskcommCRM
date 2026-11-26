/**
 * O modelo da conta ChatGPT conectada por login, pronto para `generateObject` /
 * `generateText`.
 *
 * A inferência pela assinatura (Sign in with ChatGPT) só aceita a Responses API
 * em STREAMING, com `store: false`, e recusa com 400 os parâmetros de
 * amostragem e de teto de saída (`temperature`, `max_output_tokens`…). O
 * upstream resolve isso dentro do motor do agente, chamando `streamText`
 * (run-model-call.ts, #1639). Aqui o mesmo contrato vira um middleware do
 * próprio modelo: quem chama segue usando `generateObject` normalmente, e a
 * chamada sai em streaming e é remontada numa resposta única.
 *
 * O modelo em si vem da FÁBRICA OFICIAL (`createDefaultRegistry`): mesmo
 * endpoint e mesma contenção de saída de rede do motor do agente. Este arquivo
 * só acrescenta o embrulho de streaming que o `generateObject` precisa.
 */
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";

type Params = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
type OpcoesDoWrap = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0];
type ResultadoDoStream = Awaited<ReturnType<OpcoesDoWrap["doStream"]>>;
type ParteDoStream = ResultadoDoStream["stream"] extends ReadableStream<infer T> ? T : never;
type ResultadoDoGenerate = Awaited<ReturnType<OpcoesDoWrap["doGenerate"]>>;

/** Tira o que a assinatura recusa e liga `store: false`. Puro. */
export function paramsDaAssinatura(params: Params): Params {
  const { temperature: _t, maxOutputTokens: _m, topP: _p, topK: _k, presencePenalty: _pp, frequencyPenalty: _fp, seed: _s, ...resto } =
    params;
  const openai = (params.providerOptions?.openai ?? {}) as Record<string, unknown>;
  return { ...resto, providerOptions: { ...params.providerOptions, openai: { ...openai, store: false } } } as Params;
}

export const middlewareDaAssinatura: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => paramsDaAssinatura(params),
  wrapGenerate: async ({ doStream }) => {
    const { stream, request, response } = await doStream();
    const leitor = stream.getReader();
    let texto = "";
    let warnings: unknown[] = [];
    let fim: Extract<ParteDoStream, { type: "finish" }> | null = null;
    let meta: Record<string, unknown> = {};
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      const parte = value as ParteDoStream;
      if (parte.type === "text-delta") texto += parte.delta;
      else if (parte.type === "stream-start") warnings = parte.warnings;
      else if (parte.type === "response-metadata") {
        const { type: _tipo, ...resto } = parte;
        meta = resto;
      }
      else if (parte.type === "finish") fim = parte;
      else if (parte.type === "error") throw parte.error;
    }
    if (!fim) throw new Error("a assinatura encerrou a resposta sem concluir");
    const content: ResultadoDoGenerate["content"] = texto ? [{ type: "text", text: texto }] : [];
    return {
      content,
      finishReason: fim.finishReason,
      usage: fim.usage,
      providerMetadata: fim.providerMetadata,
      request,
      response: { ...response, ...meta },
      warnings,
    } as ResultadoDoGenerate;
  },
};

export function modeloDaAssinatura(accessToken: string, modelId: string): LanguageModel {
  return wrapLanguageModel({
    model: createDefaultRegistry()[PROVEDOR_POR_ASSINATURA]!(accessToken, modelId) as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: middlewareDaAssinatura,
  });
}
