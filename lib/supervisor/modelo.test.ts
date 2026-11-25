import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolver = vi.fn();
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: (...a: unknown[]) => resolver(...a) }));

import { resolverModeloDoSupervisor } from "./modelo";
import { BancoEmMemoria } from "./testing/banco-em-memoria";

const ORG = "00000000-0000-4000-8000-00000000000a";
let db: BancoEmMemoria;
const chama = () => resolverModeloDoSupervisor(db as unknown as SupabaseClient, "supervisor_observe", ORG, "anthropic/claude-haiku-4-5");

beforeEach(() => {
  db = new BancoEmMemoria();
  resolver.mockReset();
  db.linhas("ai_models").push(
    { provider: "google", model_id: "gemini-velho", is_default_for_provider: true, deprecated_at: "2026-01-01" },
    { provider: "google", model_id: "gemini-padrao", is_default_for_provider: true, deprecated_at: null },
    { provider: "google", model_id: "gemini-outro", is_default_for_provider: false, deprecated_at: null },
  );
});

describe("modelo do Supervisor", () => {
  it("quando o padrão do ponto resolve, não procura mais nada", async () => {
    resolver.mockResolvedValueOnce({ modelId: "anthropic/claude-haiku-4-5" });
    expect(await chama()).toEqual({ modelId: "anthropic/claude-haiku-4-5" });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("organização só com credencial de OUTRO provedor: usa o modelo padrão dele, do catálogo", async () => {
    db.linhas("ai_provider_credentials").push({ organization_id: ORG, provider: "google", is_active: true, created_at: "2026-11-15" });
    resolver.mockResolvedValueOnce(null).mockResolvedValueOnce({ modelId: "google/gemini-padrao" });
    expect(await chama()).toEqual({ modelId: "google/gemini-padrao" });
    expect(resolver.mock.calls[1]).toEqual(["supervisor_observe", ORG, "google/gemini-padrao"]);
  });

  it("credencial de outra organização ou inativa não conta; sem credencial devolve null", async () => {
    db.linhas("ai_provider_credentials").push(
      { organization_id: "00000000-0000-4000-8000-00000000000b", provider: "google", is_active: true, created_at: "2026-11-15" },
      { organization_id: ORG, provider: "google", is_active: false, created_at: "2026-11-15" },
    );
    resolver.mockResolvedValue(null);
    expect(await chama()).toBeNull();
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
