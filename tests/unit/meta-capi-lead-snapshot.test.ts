import { describe, expect, it } from "vitest";

import { montaPayloadDoClone } from "@/lib/leads/clonar-para-funil";
import {
  CHAVE_DA_PROVA_META_CAPI_LEAD,
  lerProvaMetaCapiLead,
  removerProvaMetaCapiLead,
} from "@/lib/leads/prova-meta-capi-lead";

const PROVA = {
  platform: "meta_ads",
  source_type: "ad",
  ctwa_clid: "CTWA_SECRETO",
  message_id: "11111111-1111-1111-1111-111111111111",
  conversation_id: "22222222-2222-2222-2222-222222222222",
  captured_at: "2026-09-20T12:00:00.000Z",
} as const;

describe("snapshot causal do Meta CAPI Lead", () => {
  it("aceita somente o formato reservado completo", () => {
    expect(lerProvaMetaCapiLead({ [CHAVE_DA_PROVA_META_CAPI_LEAD]: PROVA })).toEqual(PROVA);
    expect(
      lerProvaMetaCapiLead({
        ad_source_id: "NAO_E_PROVA",
        ad_id: "NAO_E_CLIQUE",
        source_id: "TAMBEM_NAO",
      }),
    ).toBeNull();
    expect(
      lerProvaMetaCapiLead({
        [CHAVE_DA_PROVA_META_CAPI_LEAD]: { ...PROVA, source_type: "post" },
      }),
    ).toBeNull();
  });

  it("remove só a chave reservada e preserva o restante do metadata", () => {
    expect(
      removerProvaMetaCapiLead({ canal: "whatsapp", [CHAVE_DA_PROVA_META_CAPI_LEAD]: PROVA }),
    ).toEqual({ canal: "whatsapp" });
  });

  it("clone nunca herda a prova do nascimento original", () => {
    const payload = montaPayloadDoClone(
      {
        id: "lead-origem",
        pipeline_id: "pipe-origem",
        status: "open",
        title: "Negócio",
        source_metadata: {
          canal: "whatsapp",
          [CHAVE_DA_PROVA_META_CAPI_LEAD]: PROVA,
        },
      },
      {
        id: "stage-destino",
        pipeline_id: "pipe-destino",
        position: 1,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
    );

    expect(payload.source_metadata).toMatchObject({ canal: "whatsapp" });
    expect(payload.source_metadata).not.toHaveProperty(CHAVE_DA_PROVA_META_CAPI_LEAD);
  });
});
