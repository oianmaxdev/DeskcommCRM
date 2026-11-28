# Marcos comerciais de etapas puladas → conversões Meta (28/11/2026)

## Problema

Na homologação do PipeMax (demo Bella Moda, 1.126.1002 + PR #5), o Supervisor levou a
Raquel de **Novo Lead** direto para **Negociação**. A regra *Negociação → InitiateCheckout*
disparou; a regra *Qualificação → QualifiedLead* **não**, embora a conversa tivesse
qualificado a cliente (produto, ocasião, tamanho, data). O consumidor
`lib/conversoes/etapa-meta.handler.ts` só olha `lead.stage_changed.to_stage_id`: a
etapa de destino. O dado que a Meta mais precisa para otimizar (lead qualificado)
se perde justamente quando a IA é mais eficiente.

## Alternativas

| | Alternativa | Por que não / por que sim |
|---|---|---|
| A | Disparar as regras de **todas** as etapas entre a origem e o destino | Recusada: indiscriminada. Um salto não prova que cada etapa aconteceu (pedido explícito do dono). |
| B | Mover etapa por etapa (Novo → Qualificação → … → Negociação) | Recusada: movimento artificial, polui timeline/automações/follow-up e muda a semântica do funil. |
| C | Novo tipo de ação `register_milestone` em `supervisor_actions` | Recusada para o MVP: exige migration (CHECK de `kind`) e cria um segundo caminho de aprovação. |
| D | Integração nova de conversões "por marco" com tabela própria | Recusada: duplica livro-razão, dedupe, reenvio e tela de histórico. |
| **E** | **Marco comprovado viaja DENTRO do movimento e vira um evento que o consumidor existente já sabe tratar** | **Escolhida.** |

## Desenho escolhido (E)

1. **Evidência da IA** — `analiseSchema.marcos[]`: `{stage_ref, evidencia{mensagem, trecho}}`.
   O prompt pede só etapas cujo critério a conversa *comprova*, inclusive as que o
   negócio pularia; na dúvida, nenhuma.
2. **Política** (`decideAcoes`, `lib/supervisor/politica.ts`) — aceita um marco só se:
   há movimento **para frente** nesta rodada; a etapa está **estritamente entre** a atual e
   o destino; não é arquivada, ganho ou perda; a citação passa por `verificaEvidencia`
   (trecho literal na janela). O marco é gravado em `move_stage.after.marcos[]` com
   `stage_id`, `message_id` e `occurred_at` = horário da mensagem citada.
   - Movimento que espera aprovação → os marcos esperam junto (aprovar aplica os dois;
     recusar descarta os dois). Sem caminho novo de aprovação.
   - Descarte por evidência inválida fica em `descartes` (`marco:<etapa>`), auditável.
3. **Executor** (`lib/supervisor/executor.ts`) — ao aplicar o movimento, depois de
   `lead.stage_changed`, emite um `lead.milestone_reached` por marco (`emit_event`,
   mesma metadata/origem do Supervisor). O jsonb é revalidado (`marcosDaAcao`).
4. **Consumidor** (`etapa-meta.handler.ts`) — passa a assinar `lead.milestone_reached`
   e o trata como entrada na etapa, com a mesma regra (`lerRegraMetaDaEtapa`), o mesmo
   livro-razão e a mesma chave `MetaEtapa:<stage_id>`. Diferenças: `event_time` = horário
   da mensagem (nunca no futuro do evento; sem horário válido → `marco_sem_horario`).

## Propriedades

| Requisito | Como fica |
|---|---|
| Regras configuradas pela empresa | Só sai evento se a etapa do marco tem regra Meta ligada (mesma tela). |
| Evidência de qualificação | Citação literal obrigatória, verificada no código. |
| Salto para etapa posterior | Coberto (alvo do desenho). |
| Retorno de etapa | Movimento para trás nunca carrega marco; `sent` nunca é rebaixado. |
| Já enviado | Mesma chave do livro-razão: marco + entrada real na etapa → um envio só. `event_id` = `<lead>:MetaEtapa:<etapa>` para a Meta deduplicar. |
| Orgânico × pago | Inalterado: `processarConversao` exige atribuição de anúncio. |
| Identificadores de atribuição | Inalterados (`ctwa_clid`/`fbc`/`fbp` + `ph`). |
| Aprovação de sensíveis | Marco herda o status do movimento. |
| Horário real | `event_time` = mensagem que comprovou o marco. |
| Sem retroatividade | Guarda `configured_at` sobre o instante do reconhecimento; marcos só nascem de leituras novas; limite de 7 dias da Meta segue no envio. |
| Isolamento | Etapa resolvida do funil do próprio negócio; consumidor filtra `organization_id`. |
| Semântica Meta | Nenhum evento novo: sai o evento que a empresa já configurou para a etapa. |
| Atualizações oficiais | Mudança aditiva em 4 arquivos; nenhum schema/migration; evento novo sem CHECK. |

## Limites conhecidos

- Marco só nasce junto de um movimento do Supervisor. Negócio que já está adiante (pulado
  por um humano no passado) não ganha marco retroativo — de propósito.
- O consumidor de etapa do **Google Ads** não assina o evento de marco (fora do escopo).
- A decisão de que o critério foi comprovado é do modelo; o código garante a citação
  literal, não o julgamento.
