import { describe, expect, it } from "vitest";

import {
  ancoraCtwaDaMensagem,
  lerProvaMetaLeadSubmitted,
  ocultarProvaMetaNaResposta,
  removerProvaMetaLeadSubmitted,
} from "@/lib/leads/prova-meta-lead-submitted";
import { extrairAtribuicaoMeta } from "@/lib/channels/atribuicao-de-anuncio-oficial";
import { extrairAtribuicaoWaha } from "@/lib/waha/atribuicao-de-anuncio";
import { montaPayloadDoClone } from "@/lib/leads/clonar-para-funil";

const CLICK = "clid-atual";

describe("prova reservada do nascimento CTWA", () => {
  it("a âncora usa somente o clique da mensagem atual, sem referral bruto", () => {
    const atribuicao = extrairAtribuicaoMeta({
      source_type: "ad",
      source_id: "ad-123",
      ctwa_clid: CLICK,
      body: "texto privado",
    });
    expect(ancoraCtwaDaMensagem(atribuicao)).toEqual({
      meta_ctwa_message_v1: { platform: "meta_ads", source_type: "ad", ctwa_clid: CLICK },
    });
  });

  it("anúncio sem clique e post orgânico não viram âncora", () => {
    expect(
      ancoraCtwaDaMensagem(extrairAtribuicaoMeta({ source_type: "ad", source_id: "ad-123" })),
    ).toEqual({});
    expect(
      ancoraCtwaDaMensagem(extrairAtribuicaoMeta({ source_type: "post", ctwa_clid: CLICK })),
    ).toEqual({});
  });

  it("WAHA NOWEB também separa ctwaClid do sourceId do anúncio", () => {
    const reply = (ad: Record<string, unknown>) => ({
      extendedTextMessage: { contextInfo: { externalAdReply: ad } },
    });
    expect(ancoraCtwaDaMensagem(extrairAtribuicaoWaha(reply({
      sourceType: "ad", sourceId: "anuncio-1", ctwaClid: CLICK,
    })))).toEqual({
      meta_ctwa_message_v1: { platform: "meta_ads", source_type: "ad", ctwa_clid: CLICK },
    });
    expect(ancoraCtwaDaMensagem(extrairAtribuicaoWaha(reply({
      sourceType: "ad", sourceId: "anuncio-1",
    })))).toEqual({});
  });

  it("só aceita prova versionada e remove a chave sem perder metadados normais", () => {
    const proof = {
      platform: "meta_ads",
      source_type: "ad",
      ctwa_clid: CLICK,
      message_id: "44444444-4444-4444-8444-444444444444",
      conversation_id: "55555555-5555-4555-8555-555555555555",
      captured_at: "2026-10-04T01:00:00Z",
    };
    expect(lerProvaMetaLeadSubmitted({ meta_capi_lead_birth_v1: proof })).toEqual(proof);
    expect(lerProvaMetaLeadSubmitted({ ad_id: "ad-123" })).toBeNull();
    expect(
      removerProvaMetaLeadSubmitted({ ad_id: "ad-123", meta_capi_lead_birth_v1: proof }),
    ).toEqual({ ad_id: "ad-123" });
  });

  it("clone para outro funil não herda a prova reservada", () => {
    const destino = montaPayloadDoClone(
      {
        id: "11111111-1111-4111-8111-111111111111",
        pipeline_id: "22222222-2222-4222-8222-222222222222",
        status: "open",
        title: "Primeiro negócio",
        source_metadata: {
          campanha: "anúncio",
          meta_capi_lead_birth_v1: { ctwa_clid: CLICK },
        },
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        pipeline_id: "44444444-4444-4444-8444-444444444444",
        position: 0,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
    );
    expect(destino.source_metadata).toMatchObject({ campanha: "anúncio" });
    expect(destino.source_metadata).not.toHaveProperty("meta_capi_lead_birth_v1");
  });

  it("resposta pública mantém a origem sem expor a prova interna", () => {
    expect(ocultarProvaMetaNaResposta({
      id: "lead", source_metadata: {
        ad_platform: "meta_ads",
        meta_capi_lead_birth_v1: { ctwa_clid: CLICK },
      },
    })).toEqual({ id: "lead", source_metadata: { ad_platform: "meta_ads" } });
  });
});
