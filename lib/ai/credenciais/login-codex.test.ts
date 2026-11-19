import { describe, expect, it } from "vitest";

import { codeChallengeS256, lerRetornoColado, montarUrlDeAutorizacao } from "@/lib/ai/pontos/pkce-da-assinatura";
import { declaracoesDoIdToken, escolherModeloDaAssinatura } from "./login-codex";

describe("login pela assinatura do ChatGPT", () => {
  it("o desafio PKCE é o S256 do verificador (conferido contra hashlib do Python)", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K1uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "DpW_nzyKLmXOCjIx2Ik4CEMHAv6AF_zNMXGb5Z9P0oI",
    );
  });

  it("a URL de autorização pede os escopos da assinatura e o retorno local", () => {
    const url = new URL(
      montarUrlDeAutorizacao({ codeChallenge: "c", estado: "e", nonce: "n", extAgentHostId: "urn:uuid:x" }),
    );
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("lê o endereço colado e recusa colagem sem estado", () => {
    expect(lerRetornoColado("http://127.0.0.1:1455/auth/callback?code=abc&state=st&client_id=cli")).toEqual({
      code: "abc",
      state: "st",
      clientId: "cli",
    });
    expect(lerRetornoColado("abc")).toBeNull();
    expect(lerRetornoColado("http://127.0.0.1:1455/auth/callback?code=abc")).toBeNull();
  });

  it("escolhe o modelo: a escolha explícita ou nada; sem escolha, a preferência; senão o primeiro", () => {
    expect(escolherModeloDaAssinatura(["gpt-5", "gpt-5-mini", "o3"], "o3")).toBe("o3");
    // escolha explícita que a conta não tem: nada, nunca outro modelo em silêncio
    expect(escolherModeloDaAssinatura(["gpt-5.6-sol", "gpt-6-astra"], "gpt-5.6-luna")).toBeNull();
    expect(escolherModeloDaAssinatura(["gpt-5.6-luna", "gpt-5.6-sol"], "gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(escolherModeloDaAssinatura(["gpt-5", "gpt-5-mini", "o3"])).toBe("gpt-5-mini");
    expect(escolherModeloDaAssinatura(["gpt-5.1", "o3"])).toBe("gpt-5.1");
    expect(escolherModeloDaAssinatura(["codex-x"])).toBe("codex-x");
    expect(escolherModeloDaAssinatura([])).toBeNull();
  });

  it("decodifica as declarações do id_token e recusa formato inválido", () => {
    const corpo = Buffer.from(JSON.stringify({ sub: "u1", nonce: "n" })).toString("base64url");
    expect(declaracoesDoIdToken(`h.${corpo}.s`)).toEqual({ sub: "u1", nonce: "n" });
    expect(declaracoesDoIdToken("nao-e-jwt")).toBeNull();
  });
});
