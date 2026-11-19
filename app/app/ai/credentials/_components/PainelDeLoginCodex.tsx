"use client";

/**
 * Conectar a conta do ChatGPT da empresa pela assinatura, sem chave de API.
 * Porte enxuto do painel do repositório oficial (#1639): gera o link, a pessoa
 * entra na conta da OpenAI, e cola de volta o endereço para onde foi levada.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  conectarLoginCodex,
  desconectarLoginCodexAgora,
  iniciarLoginCodex,
} from "@/app/actions/settings/conectarLoginCodex";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

const MENSAGENS: Record<string, string> = {
  invalid_input: "Cole o endereço inteiro que o navegador mostrou depois de entrar na conta.",
  retorno_sem_estado: "Cole o endereço inteiro que o navegador mostrou depois de entrar na conta.",
  consentimento_recusado: "O acesso não foi autorizado na conta da OpenAI.",
  estado_invalido: "O link expirou ou já foi usado. Gere um link novo e tente de novo.",
  registro_incompleto: "A OpenAI não concluiu o cadastro desta instalação. Gere um link novo e tente de novo.",
  troca_recusada: "A OpenAI recusou o código. Ele é de uso único: gere um link novo.",
  plano_nao_autorizado: "Esta conta não concedeu acesso aos modelos pela assinatura.",
  identidade_invalida: "Não foi possível confirmar a identidade devolvida pela OpenAI. Gere um link novo.",
  conta_diferente: "Esta empresa já está ligada a outra conta ChatGPT. Desconecte antes de trocar.",
  forbidden_role: "Só quem administra a empresa pode conectar a conta.",
  mfa_required: "Confirme a verificação em duas etapas antes de conectar.",
  banco: "O banco recusou a gravação. Tente de novo em instantes.",
};

export function PainelDeLoginCodex({
  conectado,
  conta,
  modelos,
  erroDaConta,
  canWrite,
}: {
  conectado: boolean;
  /** Final do e-mail da conta conectada (o resto nunca chega à tela). */
  conta: string | null;
  modelos: number;
  erroDaConta: string | null;
  canWrite: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [link, setLink] = useState<{ url: string; codeVerifier: string } | null>(null);
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  const falha = (codigoDoErro: string) => setErro(t(MENSAGENS[codigoDoErro] ?? "Não foi possível concluir. Tente de novo."));

  const gerarLink = () =>
    startTransition(async () => {
      setErro(null);
      const r = await iniciarLoginCodex();
      if (!r.ok) return falha(r.error);
      setLink({ url: r.url, codeVerifier: r.codeVerifier });
      window.open(r.url, "_blank", "noopener,noreferrer");
    });

  const conectar = () =>
    startTransition(async () => {
      if (!link) return;
      setErro(null);
      const r = await conectarLoginCodex({ codigo, codeVerifier: link.codeVerifier });
      if (!r.ok) return falha(r.error);
      setLink(null);
      setCodigo("");
      router.refresh();
    });

  const desconectar = () =>
    startTransition(async () => {
      setErro(null);
      const r = await desconectarLoginCodexAgora();
      if (!r.ok) return falha(r.error);
      router.refresh();
    });

  return (
    <Card data-testid="painel-login-codex">
      <CardHeader>
        <CardTitle className="text-base">{t("OpenAI pela assinatura (ChatGPT)")}</CardTitle>
        <CardDescription>
          {t(
            "Entre com a conta do ChatGPT da empresa em vez de colar uma chave de API. O uso sai dos limites da assinatura dessa conta.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {conectado ? (
          <>
            <p data-testid="assinatura-conectada">
              {t("Conectada")}
              {conta ? ` (…${conta})` : ""} · {modelos} {t("modelos disponíveis")}
            </p>
            {erroDaConta ? <p className="text-destructive">{t(erroDaConta)}</p> : null}
            {canWrite ? (
              <div>
                <Button variant="outline" size="sm" onClick={desconectar} disabled={pendente}>
                  {t("Desconectar")}
                </Button>
              </div>
            ) : null}
          </>
        ) : canWrite ? (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>{t("Clique em “Entrar com o ChatGPT” e autorize na conta da OpenAI.")}</li>
              <li>
                {t(
                  "No fim, o navegador vai para um endereço que começa com http://127.0.0.1:1455 e não abre. Isso é esperado: copie esse endereço inteiro.",
                )}
              </li>
              <li>{t("Cole o endereço abaixo e clique em “Conectar”.")}</li>
            </ol>
            <div>
              <Button size="sm" onClick={gerarLink} disabled={pendente}>
                {t("Entrar com o ChatGPT")}
              </Button>
              {link ? (
                <a className="ml-3 text-xs underline" href={link.url} target="_blank" rel="noopener noreferrer">
                  {t("Abrir o link de novo")}
                </a>
              ) : null}
            </div>
            {link ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="retorno-codex">{t("Endereço para onde o navegador foi levado")}</Label>
                <Input
                  id="retorno-codex"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                  autoComplete="off"
                />
                <div>
                  <Button size="sm" onClick={conectar} disabled={pendente || codigo.trim() === ""}>
                    {t("Conectar")}
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">{t("Só quem administra a empresa pode conectar a conta.")}</p>
        )}
        {erro ? (
          <p role="alert" className="text-destructive">
            {erro}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
