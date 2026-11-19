/**
 * O PDF do diagnóstico comercial.
 *
 * Renderiza um diagnóstico JÁ GRAVADO — nenhuma chamada de modelo, nenhum
 * recálculo: os mesmos casos, evidências e contagens da tela. Texto de verdade
 * (pesquisável e selecionável), cabeçalho e rodapé fixos com paginação, e
 * blocos de conversa/análise que não se partem entre páginas (`wrap={false}`).
 *
 * As "evidências" são as mensagens reais da conversa, desenhadas como balões
 * com autor e horário — não há captura de tela fabricada. Os exemplos de
 * abordagem vêm numa caixa rotulada "sugestão", para nunca se confundirem com
 * o que foi dito de fato.
 *
 * Cores só em HEX: `var()` e `oklch()` renderizam PDF válido e somem em
 * silêncio no @react-pdf (ver o cabeçalho de lib/lgpd/pdf-renderer.tsx).
 * O arquivo não é armazenado: sai do banco para o download e some.
 */
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

import { ROTULO_DO_PROBLEMA } from "./metricas";
import {
  AUTOR_DA_MENSAGEM,
  avisoDeIncompleto,
  BASE_DA_AVALIACAO,
  falhasPorCategoria,
  limparDiagnostico,
  notaDosDenominadores,
  type CasoDoRelatorio,
  type RelatorioGravado,
} from "./relatorio-tipos";

export interface OpcoesDoPdf {
  /** `resumo` = só o diagnóstico geral; `detalhado` = com os estudos de caso (até 5). */
  modo: "detalhado" | "resumo";
  /** Troca o título dos negócios por "Atendimento N" (para circular fora da empresa). */
  anonimo: boolean;
  organizacao: string;
  fuso: string | null;
  rotuloDoCriterio: (id: string) => string;
  geradoEm: Date;
}

const COR = { tinta: "#1f2933", suave: "#5b6770", linha: "#d9dee3", fundo: "#f4f6f8", marca: "#2f5d50", cliente: "#eef1f4", vendedor: "#e3efe9", alerta: "#8a5a00", bom: "#2f6b3f" };

const s = StyleSheet.create({
  page: { paddingTop: 64, paddingBottom: 52, paddingHorizontal: 44, fontSize: 10, color: COR.tinta, fontFamily: "Helvetica", lineHeight: 1.45 },
  cabecalho: { position: "absolute", top: 24, left: 44, right: 44, flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: COR.linha, paddingBottom: 6, fontSize: 8, color: COR.suave },
  // `top` e não `bottom`: neste layout o elemento fixo ancorado por `bottom` não
  // era desenhado (medido extraindo o texto do PDF). A4 tem 841,89 pt de altura.
  rodape: { position: "absolute", top: 808, left: 44, right: 44, textAlign: "center", fontSize: 8, color: COR.suave },
  capaTitulo: { fontSize: 22, fontFamily: "Helvetica-Bold", lineHeight: 1.2, marginBottom: 8 },
  capaSub: { fontSize: 12, color: COR.suave, marginBottom: 16 },
  h1: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 6, color: COR.marca },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 3 },
  p: { marginBottom: 5 },
  suave: { color: COR.suave },
  negrito: { fontFamily: "Helvetica-Bold" },
  caixa: { backgroundColor: COR.fundo, borderRadius: 4, padding: 8, marginBottom: 6 },
  linhaTabela: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 0.5, borderBottomColor: COR.linha, paddingVertical: 3 },
  cartao: { borderWidth: 1, borderColor: COR.linha, borderRadius: 4, padding: 8, marginBottom: 6 },
  item: { flexDirection: "row", marginBottom: 3 },
  marcador: { width: 10 },
  itemTexto: { flex: 1 },
  balao: { borderRadius: 6, padding: 6, marginBottom: 4, maxWidth: "82%" },
  balaoMeta: { fontSize: 7.5, color: COR.suave, marginBottom: 1 },
  sugestao: { borderLeftWidth: 3, borderLeftColor: COR.marca, backgroundColor: COR.fundo, padding: 7, marginBottom: 5 },
  sugestaoRotulo: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: COR.marca, marginBottom: 2 },
  recorrencia: { backgroundColor: "#fff6e0", borderRadius: 4, padding: 7, marginTop: 4, color: COR.alerta, fontFamily: "Helvetica-Bold" },
  aviso: { backgroundColor: "#fdecea", borderLeftWidth: 3, borderLeftColor: "#b3261e", padding: 8, marginBottom: 6, color: "#5f1410" },
  casoTitulo: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 2 },
});

/**
 * As fontes padrão do PDF só têm Latin-1: emoji e seta viram quadrado ou somem.
 * Troca o que tem equivalente e remove o resto — sem alterar palavra nenhuma.
 */
export function textoParaPdf(v: string | null | undefined): string {
  return (v ?? "")
    .replace(/[→➜➔]/g, "->")
    .replace(/…/g, "...")
    .replace(/[‘’]/g, "'")
    .replace(/[^\u0009\u000a -ÿ–—“”•]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
const T = textoParaPdf;

function data(iso: string, fuso: string | null, comHora = false): string {
  let tz: string | undefined = fuso ?? undefined;
  try {
    if (tz) new Intl.DateTimeFormat("pt-BR", { timeZone: tz });
  } catch {
    tz = undefined;
  }
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", ...(comHora ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(new Date(iso));
}

function Lista({ itens, marcador = "•" }: { itens: string[]; marcador?: string }) {
  return (
    <View>
      {itens.map((t, i) => (
        <View key={i} style={s.item} wrap={false}>
          <Text style={s.marcador}>{marcador}</Text>
          <Text style={s.itemTexto}>{T(t)}</Text>
        </View>
      ))}
    </View>
  );
}

function Caso({ caso, n, titulo, fuso }: { caso: CasoDoRelatorio; n: number; titulo: string; fuso: string | null }) {
  return (
    <View break={n > 1}>
      <Text style={[s.suave, { fontSize: 8 }]}>
        ESTUDO DE CASO {n} — {caso.tipo === "boa_pratica" ? "BOA CONDUÇÃO" : "OPORTUNIDADE DE MELHORIA"}
      </Text>
      <Text style={s.casoTitulo}>{T(titulo)}</Text>
      {caso.situacao ? (
        <Text style={[s.suave, s.p]}>
          {T(caso.situacao)}
          {caso.estagio && !caso.situacao.includes(caso.estagio) ? ` — ${T(caso.estagio)}` : ""}
        </Text>
      ) : null}
      <Text style={s.p}>{T(caso.contexto)}</Text>

      {caso.evidencias.length > 0 ? (
        <View>
          <Text style={s.h2}>Evidências do atendimento</Text>
          {caso.evidencias.map((m, i) => {
            const doCliente = m.quem === "cliente";
            return (
              <View key={i} wrap={false} style={[s.balao, { backgroundColor: doCliente ? COR.cliente : COR.vendedor, alignSelf: doCliente ? "flex-start" : "flex-end" }]}>
                <Text style={s.balaoMeta}>
                  {AUTOR_DA_MENSAGEM[m.quem]} · {data(m.em, fuso, true)}
                  {m.transcricao ? " · áudio transcrito" : ""}
                </Text>
                <Text>{T(m.texto)}</Text>
              </View>
            );
          })}
        </View>
      ) : null}

      {caso.positivos.length > 0 ? (
        <View>
          <Text style={s.h2}>O que foi positivo</Text>
          <Lista itens={caso.positivos} />
        </View>
      ) : null}

      {caso.faltou.length > 0 ? (
        <View>
          <Text style={s.h2}>O que faltou no atendimento</Text>
          {caso.faltou.map((f, i) => (
            <View key={i} style={s.item} wrap={false}>
              <Text style={s.marcador}>{"•"}</Text>
              <Text style={s.itemTexto}>
                <Text style={s.negrito}>{T(f.titulo)}: </Text>
                {T(f.explicacao)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {caso.como_melhorar.length > 0 || caso.follow_up_sugerido ? (
        <View>
          <Text style={s.h2}>Como poderia ter sido melhor</Text>
          {caso.como_melhorar.map((m, i) => (
            <View key={i} wrap={false}>
              <Text style={{ marginBottom: 2 }}>{T(m.quando)}</Text>
              <View style={s.sugestao}>
                <Text style={s.sugestaoRotulo}>SUGESTÃO DE ABORDAGEM — NÃO FOI ENVIADA</Text>
                <Text>{`“${T(m.exemplo_de_mensagem)}”`}</Text>
              </View>
            </View>
          ))}
          {caso.follow_up_sugerido ? (
            <View wrap={false}>
              <Text style={{ marginBottom: 2 }}>Sugestão de follow-up, caso o cliente não responda:</Text>
              <View style={s.sugestao}>
                <Text style={s.sugestaoRotulo}>SUGESTÃO DE FOLLOW-UP — NÃO FOI ENVIADA</Text>
                <Text>{`“${T(caso.follow_up_sugerido)}”`}</Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      <View wrap={false}>
        <Text style={s.h2}>Resumo da análise</Text>
        <Text style={s.p}>{T(caso.resumo)}</Text>
        {caso.outros_achados.length > 0 ? <Text style={[s.suave, s.p]}>Outros achados neste atendimento: {T(caso.outros_achados.join("; "))}.</Text> : null}
        {caso.limitacao ? <Text style={[s.suave, s.p]}>Limitação: {T(caso.limitacao)}</Text> : null}
        {caso.recorrencia?.frase ? <Text style={s.recorrencia}>Recorrência identificada: {T(caso.recorrencia.frase)}</Text> : null}
      </View>
    </View>
  );
}

export function DocumentoDoDiagnostico({ r, o }: { r: RelatorioGravado; o: OpcoesDoPdf }) {
  const d = limparDiagnostico(r.diagnosis ?? {});
  const ag = r.metrics?.agregado;
  const falhas = falhasPorCategoria(r);
  const casos = o.modo === "detalhado" ? (d.casos ?? []).slice(0, 5) : [];
  const periodo = `${data(r.period_from, o.fuso)} a ${data(r.period_to, o.fuso)}`;
  const base = d.contexto?.base ?? (ag?.criterios_formais ? "script" : "geral");
  return (
    <Document title={`Diagnóstico comercial — ${o.organizacao}`} author={o.organizacao} subject={`Período ${periodo}`}>
      <Page size="A4" style={s.page}>
        <View style={s.cabecalho} fixed>
          <Text>{T(o.organizacao)} · Diagnóstico comercial</Text>
          <Text>{periodo}</Text>
        </View>
        <Text style={s.capaTitulo}>Diagnóstico comercial</Text>
        <Text style={s.capaSub}>
          {T(o.organizacao)} · {periodo}
        </Text>

        <View style={s.caixa} wrap={false}>
          <Text style={s.negrito}>Escopo e cobertura</Text>
          <Text>
            Atendimentos elegíveis (com vendedor humano no período): {r.conversations_eligible} · Analisados: {r.conversations_analyzed}
            {casos.length > 0 ? ` · Estudos de caso neste relatório: ${casos.length}` : ""}
          </Text>
          <Text>Base da avaliação: {BASE_DA_AVALIACAO[base]}.</Text>
          {d.contexto?.nicho ? <Text>Ramo informado pela empresa: {T(d.contexto.nicho)}</Text> : null}
          <Text style={s.suave}>Os números consideram todos os atendimentos analisados; os estudos de caso são uma seleção de no máximo cinco.</Text>
        </View>

        {avisoDeIncompleto(r) ? (
          <View style={s.aviso} wrap={false}>
            <Text style={s.negrito}>Atenção</Text>
            <Text>{T(avisoDeIncompleto(r))}</Text>
          </View>
        ) : null}

        {d.resumo_executivo ? (
          <View>
            <Text style={s.h1}>Resumo executivo</Text>
            <Text style={s.p}>{T(d.resumo_executivo)}</Text>
          </View>
        ) : null}

        {falhas.length > 0 ? (
          <View wrap={false}>
            <Text style={s.h1}>Falhas recorrentes</Text>
            {falhas.map((f) => (
              <View key={f.codigo} style={s.linhaTabela}>
                <Text>{ROTULO_DO_PROBLEMA[f.codigo] ?? f.codigo}</Text>
                <Text>
                  {f.atendimentos} de {r.conversations_analyzed} atendimentos
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {ag && ag.aderencia.length > 0 ? (
          <View wrap={false}>
            <Text style={s.h1}>{ag.criterios_formais ? "Aderência ao script da empresa" : "Aderência às boas práticas"}</Text>
            {ag.aderencia.map((a) => (
              <View key={a.criterio} style={s.linhaTabela}>
                <Text>{T(o.rotuloDoCriterio(a.criterio))}</Text>
                <Text>
                  {a.cumpridas} de {a.avaliadas}
                  {a.pct !== null ? ` (${a.pct}%)` : ""}
                </Text>
              </View>
            ))}
            {notaDosDenominadores(ag.aderencia, r.conversations_analyzed) ? (
              <Text style={[s.suave, { fontSize: 8.5, marginTop: 3 }]}>{T(notaDosDenominadores(ag.aderencia, r.conversations_analyzed))}</Text>
            ) : null}
          </View>
        ) : null}

        {(d.gargalos ?? []).length > 0 ? (
          <View>
            <Text style={s.h1}>Principais achados</Text>
            {d.gargalos!.map((g, i) => (
              <View key={i} style={s.cartao} wrap={false}>
                <Text style={s.negrito}>{T(g.titulo)}</Text>
                <Text style={[s.suave, { fontSize: 8.5 }]}>Frequência: {T(g.frequencia_observada)}</Text>
                <Text style={{ marginTop: 2 }}>{T(g.descricao)}</Text>
                <Text style={{ marginTop: 2 }}>
                  <Text style={s.negrito}>Impacto: </Text>
                  {T(g.impacto)}
                </Text>
                <Text>
                  <Text style={s.negrito}>O que fazer: </Text>
                  {T(g.acao_recomendada)}
                </Text>
                <Text style={s.suave}>Como acompanhar: {T(g.indicador)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {(d.pontos_positivos ?? []).length > 0 ? (
          <View>
            <Text style={s.h1}>Pontos positivos</Text>
            <Lista itens={d.pontos_positivos!} />
          </View>
        ) : null}

        {(d.recomendacoes_priorizadas ?? []).length > 0 ? (
          <View>
            <Text style={s.h1}>Recomendações comerciais</Text>
            {[...d.recomendacoes_priorizadas!]
              .sort((a, b) => a.prioridade - b.prioridade)
              .map((x, i) => (
                <View key={i} style={s.item} wrap={false}>
                  <Text style={{ width: 14 }}>{i + 1}.</Text>
                  <Text style={s.itemTexto}>
                    {T(x.acao)} <Text style={s.suave}>— {T(x.indicador)}</Text>
                  </Text>
                </View>
              ))}
          </View>
        ) : null}

        {(d.riscos ?? []).length > 0 ? (
          <View>
            <Text style={s.h1}>Riscos</Text>
            <Lista itens={d.riscos!} />
          </View>
        ) : null}

        {(d.limitacoes ?? []).length > 0 ? (
          <View>
            <Text style={s.h1}>Limitações da análise</Text>
            <Lista itens={d.limitacoes!} />
          </View>
        ) : null}

        {casos.length > 0 ? (
          <View break>
            <Text style={s.h1}>Análises individuais dos atendimentos</Text>
            <Text style={[s.suave, s.p]}>
              {casos.length === 1 ? "Um atendimento foi escolhido por representar" : `${casos.length} atendimentos foram escolhidos por representarem`} os achados mais relevantes do período. As
              mensagens exibidas são trechos reais das conversas; as sugestões de abordagem são exemplos e não foram enviadas.
            </Text>
            {casos.map((c, i) => (
              <Caso key={c.conversation_id} caso={c} n={i + 1} titulo={o.anonimo ? `Atendimento ${i + 1}` : c.titulo} fuso={o.fuso} />
            ))}
          </View>
        ) : null}

        {/* Rodapé por ÚLTIMO, como em lib/lgpd/pdf-renderer.tsx: declarado antes do
            conteúdo, o elemento fixo de baixo simplesmente não era desenhado (medido). */}
        <Text
          style={s.rodape}
          fixed
          render={({ pageNumber, totalPages }) =>
            `Gerado em ${data(o.geradoEm.toISOString(), o.fuso, true)} · análise assistida por IA sobre as conversas do período · Página ${pageNumber} de ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}

export async function renderizaDiagnosticoEmPdf(r: RelatorioGravado, o: OpcoesDoPdf): Promise<Buffer> {
  return renderToBuffer(<DocumentoDoDiagnostico r={r} o={o} />);
}
