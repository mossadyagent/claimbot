# Claim Bot (pump.fun → Telegram) — estudo técnico v0

> Fase atual: **implementado**. Este documento registra o estudo que guiou o desenho.
> Para instalar e rodar, veja [README.md](README.md).
> Data da pesquisa: **20/10/2026**.

---

## 0. Resumo executivo

1. O ícone do print é o marcador de **claim de creator fee** (o "dev claim" dos terminais):
   o criador do token sacou para a própria wallet as taxas que acumulou.
2. Desde o upgrade de **outubro/2026** as taxas ficam **paradas na curva/pool** e só saem com um
   `sweep_creator_fee` seguido de um `collect_*`/`distribute_*` **na mesma transação**. Isso é ótimo
   para nós: o sweep carrega o **mint** e o claim carrega o **valor** — dá para montar o alerta completo.
3. Existem **5 caminhos de pagamento** diferentes (2 programas + o programa de fees). Filtrar só
   `collectCreatorFee` deixa coisa de fora; filtrar demais traz lixo (cashback, sweep, transferência interna).
4. O claim de creator fee é **por wallet de criador**, não por token: um claim pode varrer vários tokens
   de uma vez. O filtro de market cap precisa de uma regra de atribuição (proposta na seção 2.3).
5. Detecção viável e barata: **`logsSubscribe` nos programas Pump/PumpSwap** + decode local dos eventos +
   `getTransaction` **só** quando o valor do evento já passou do corte de 10 SOL. Custo baixo, latência ~1–3 s.
   Índice pronto (Bitquery/NoLimitNodes) é a alternativa sem WebSocket, com custo por uso.

---

## 1. O que é exatamente o "claim" da foto

### 1.1 O que o terminal está marcando

O selo verde com carteira + moeda no candle é o evento **creator fee claim**: o criador (dev) sacou as
taxas de trading acumuladas do token para a wallet dele. Não é venda do dev, não é migração, não é cashback.

> Terminal confirmado: **Axiom**. O Axiom atribui o claim ao token que está no gráfico (usando o próprio
> indexador dele). Nosso bot vai fazer a mesma atribuição por conta própria — via sweep na tx e, quando
> não houver, pela regra da seção 2.3.

### 1.2 Como a pump.fun paga hoje (upgrade de out/2026)

- Toda trade v3/v2 **não paga** a creator fee na hora: ela fica registrada em `BondingCurve.creator_fee`
  (curva) ou `Pool.creator_fees` (PumpSwap).
- Quem quiser paga depois com `sweep_creator_fee` (permissionless), que move o valor para o
  **creator vault** — PDA `[b"creator-vault", creator]`, ou seja, **um vault por wallet de criador**,
  somando todos os tokens dele.
- O saque do vault para a wallet é `collect_creator_fee_v2` (curva), `collect_coin_creator_fee` (pool),
  ou `distribute_creator_fees_v2` quando o token tem **sharing config** (vários beneficiários).
- O fluxo normal do site/SDK é: **sweep do token → claim, na mesma transação**. Por isso o par
  sweep+claim é a assinatura que procuramos.

### 1.3 Instruções e eventos que interessam

Discriminadores conferidos localmente (`sha256("global:<nome>")[0..8]` / `sha256("event:<Nome>")[0..8]`):

| Instrução | Programa | É pagamento? | Traz mint? | Evento de pagamento |
|---|---|---|---|---|
| `collect_creator_fee` (`1416567bc61cdb84`) | Pump | ✅ | ❌ | `CollectCreatorFeeEvent` (`7a027f010ebf0caf`) |
| `collect_creator_fee_v2` (`cf118af204221338`) | Pump | ✅ | ❌ | idem |
| `collect_coin_creator_fee` (`a039592ab58b2b42`) | PumpSwap | ✅ | ❌ | `CollectCoinCreatorFeeEvent` (`e8f5c2eeeada3a59`) |
| `distribute_creator_fees` (`a572670079cef751`) | Pump | ✅ | ✅ (accounts[0]) | `DistributeCreatorFeesEvent` (`a537817004b3ca28`) |
| `distribute_creator_fees_v2` (`ffcb134ff444089f`) | Pump | ✅ | ✅ (accounts[1]) | idem |
| `sweep_creator_fee` (`20f6bf3408c949ba`) | Pump/PumpSwap | ❌ | ✅ (base_mint / pool) | — |
| `transfer_creator_fees_to_pump` (`8b348655e4e56cf1`) | PumpSwap | ❌ (só move p/ o vault Pump) | — | — |
| `claim_cashback` (`253a237ebe35e4c5`) | Pump/PumpSwap | ❌ (é reembolso do trader) | — | — |
| `claim_social_fee_pda` (`e115fb85a11ec7e2`) | PumpFees | ❌ p/ o nosso caso (claim de GitHub) | — | — |

Formato dos eventos (confirmado na doc oficial / SDK Rust):

```
CollectCreatorFeeEvent { timestamp: i64, creator: Pubkey, creator_fee: u64 }   // + quote_mint em versões novas
DistributeCreatorFeesEvent { mint, distributed, ... }
```

Ou seja: **valor e dev vêm do log** (grátis, sem RPC extra); **o token vem do sweep** (precisa da tx).

### 1.4 O que NÃO é claim (e não pode entrar no filtro)

- `sweep_creator_fee` / `sweep_protocol_fee` — só movem dinheiro para o vault/fee recipient; ninguém recebe.
- `transfer_creator_fees_to_pump` — pool → vault Pump, pagamento zero.
- `claim_cashback` — devolução de taxa para quem negociou; não é o dev sacando.
- `claim_social_fee_pda` — claim de taxa social (GitHub), outro produto.
- Claim "fake" — instrução chamada sem evento de pagamento (valor 0). Descartar.

### 1.5 Detalhes que mudam a leitura do sinal

- **É permissionless**: qualquer um (bot, MEV, o próprio site) pode executar o claim no lugar do dev.
  Então "claim" ≠ "o dev clicou agora". O que importa é o **recipient** (o `creator` do evento).
- **É por wallet, não por token**: um claim pode somar taxas de 5 tokens do mesmo dev.
- **Sharing config**: tokens com divisão de receita pagam via `distribute_creator_fees` — aí o evento
  já diz o mint e o valor daquele token.
- **Quote em USDC**: existem tokens pareados em USDC; nesse caso o valor do evento é em USDC (6 casas),
  não em lamports. O filtro de 10 SOL precisa ignorar (ou converter) esses casos na v1.

---

## 2. Os dois filtros

### 2.1 "Mínimo 10 SOL de claim"

Fonte do valor: `creator_fee` do `CollectCreatorFeeEvent` (lamports) ou `distributed` do
`DistributeCreatorFeesEvent`. Sem RPC extra — o valor vem no log.

Cuidados:
- somar não: cada claim instruction tem **um** evento; dois claims na mesma tx = dois alertas (ou agrupar).
- descontar nada: o valor do evento já é o líquido que caiu na wallet.
- 10 SOL é **por evento**, não por dev/dia. Se quiser "acumulado do dev", é outra feature.
- umidade: valores < 0,001 SOL são dust/fake — descartar.

### 2.2 "Market cap máximo 500k"

Precisa do **mint** e do **market cap no instante do claim**. Opções de fonte:

| Fonte | Como | Prós | Contras |
|---|---|---|---|
| DexScreener (`/latest/dex/tokens/{mint}`) | HTTP, grátis | rápido, cobre curva e graduado, traz `marketCap` USD | rate limit (~300 req/min), pode atrasar segundos em token recém-criado |
| Conta `BondingCurve` (RPC) | 1 `getAccountInfo` + decode | exato e on-chain; mcap em SOL pela fórmula oficial | trabalho de decode; não serve pós-migração |
| Conta `Pool` do PumpSwap (RPC) | 1 `getAccountInfo` + decode | exato pós-graduação | idem |
| API interna da pump.fun | HTTP | seria a mais "oficial" | instável (hoje `frontend-api*.pump.fun/coins/...` responde 404/DNS) — não confiar |

Fórmula oficial (docs pump.fun), mcap em lamports:

```
mcap_lamports = virtual_quote_reserves * mint_supply / virtual_token_reserves   // bonding curve
mcap_lamports = quote_reserve * base_mint_supply / base_reserve                // pool PumpSwap
```

Recomendação v1: **DexScreener primeiro, RPC como fallback** (e cache de 60 s por mint para não estourar
rate limit em claims repetidos do mesmo dev).

Decidido: **market cap em USD**, com teto **configurável** (500k é só o valor inicial). Precisamos do preço
do SOL no momento (DexScreener, cache 60 s) para converter o mcap da curva, que é naturalmente em SOL.

### 2.3 O problema de atribuição (o ponto mais delicado)

Como o vault é por dev, o valor do claim pode ser a soma de vários tokens. Cenários:

1. **Sweep + claim do mesmo token na tx** (fluxo padrão): 1 sweep → 1 mint → atribuição limpa. ✅
2. **Vários sweeps na mesma tx**: N mints, 1 valor agregado. Não dá para saber quanto veio de cada um.
3. **Claim sem sweep** (taxas já sweepadas antes): mint desconhecido. Só dá para atribuir
   consultando o histórico do dev / tx anteriores.

Regra proposta (v1), em ordem:

- Se houver **exatamente 1 mint** identificável (sweep na tx, ou evento `distribute_creator_fees`):
  filtra por aquele mint. **É o caso que cobre ~todo o fluxo atual da UI.**
- Se houver **N mints**: mantém o alerta se **algum** deles tiver mcap ≤ 500k; a mensagem lista todos
  com o mcap de cada um e avisa "valor agregado".
- Se **nenhum mint** identificável: **não notifica** (v1) e grava em log para medirmos a frequência.
  Se for muito comum, v2 usa índice dev→tokens.

Escopo confirmado: entra claim de token **na curva e pós-graduação** (PumpSwap), desde que o mcap no
momento do claim esteja abaixo do teto. O que separa os dois casos é só a fonte do mcap (seção 2.2).

### 2.4 Taxa de alerta esperada

Desconhecida — e é o principal risco de produto. "≥10 SOL **e** mcap ≤ 500k" pode dar 3 alertas/dia ou
300. Precisa medir antes de escolher o limiar (seção 8).

---

## 3. Detecção em tempo real

### 3.1 Por que não dá para "poll de assinaturas"

O programa Pump faz **~100 tx/s** (e o PumpSwap outro tanto). Um `getSignaturesForAddress(limit: 200)`
cobre **menos de 1 segundo** de chain — medido em produção por terceiros. Claim é raro dentro disso.
Polling é inviável; tem que ser push (WebSocket/gRPC) ou índice pronto.

### 3.2 Opção A — `logsSubscribe` + decode local (recomendada para v1)

Assina os logs de `6EF8rr…` (Pump), `pAMMBa…` (PumpSwap) e, se quiser compartilhamento, `pfeeUx…` (PumpFees).
Cada mensagem traz as linhas de log, incluindo `Program data: <base64>` dos eventos.

Pipeline:
1. filtra `err` (tx falhou) e assinatura repetida;
2. decodifica os `Program data:` e procura `CollectCreatorFeeEvent` / `DistributeCreatorFeesEvent` /
   `CollectCoinCreatorFeeEvent`;
3. **se o valor < 10 SOL, descarta imediatamente** (sem RPC!);
4. se passou, `getParsedTransaction` uma vez → acha `sweep_creator_fee` → `base_mint` (Pump: accounts[3];
   PumpSwap: `pool` → account data → mint);
5. consulta mcap, aplica o filtro, notifica.

Vantagens: uma conexão só, custo de RPC proporcional aos candidatos, latência 1–3 s, sem dependência de
vendor. Riscos: WebSocket cai (precisa heartbeat/reconnect); **não há backfill** (se ficar 10 min offline,
esses claims se perdem); um RPC fraco derruba a conexão no firehose.

### 3.3 Opção B — Yellowstone gRPC (LaserStream/Geyser)

Mesmo conteúdo, transporte melhor (gRPC, filtro por programa/conta no servidor). Mais estável para 24/7,
mas exige provedor com gRPC (pago) e mais código. Boa evolução da v1 se o WS incomodar.

### 3.4 Opção C — índice pronto (Bitquery, NoLimitNodes…)

- **Bitquery**: `Solana.Instructions` com filtro `Program.Method in ["collect_creator_fee", ...]` +
  `Transaction.Result.Success`, via GraphQL subscription ou polling. Filtro no servidor ⇒ volume baixíssimo.
  Precisa validar se as instruções novas de out/2026 já estão decodificadas.
- **NoLimitNodes**: vende streams por evento (`PumpFun CollectCreatorFeeEvent`, `PumpSwaps
  CollectCoinCreatorFee`). Encaixe perfeito, preço a confirmar.

Vantagem: simples, com backfill, sem firehose. Desvantagem: custo mensal/por evento e dependência.

### 3.5 Opção D — reusar `pumpfun-claims-bot`

Existe um bot open source (Node/TS) que já decodifica exatamente essas instruções (v1 e v2), com dedupe,
tracker e Telegram. Serve como **referência de decode** (discriminadores, layout de eventos, atribuição) —
e talvez como base. Licença "all rights reserved": **não copiar código sem checar**; usar como documentação.

### 3.6 Comparação

| Critério | A. logsSubscribe | B. gRPC | C. Bitquery | C2. NoLimitNodes |
|---|---|---|---|---|
| Latência | 1–3 s | <1 s | 1–5 s | 1–3 s |
| Custo | RPC pago (médio) | RPC gRPC (médio/alto) | por uso | assinatura |
| Complexidade | média | alta | baixa | baixa |
| Backfill após queda | ❌ | ❌ | ✅ | ✅ |
| Dependência externa | baixa | média | alta | alta |
| Esforço p/ começar | 1 | 3 | 1 | 1 |

Recomendação: **A para a v1** (controle + custo), com o decode isolado num módulo para trocar por B/C depois.

---

## 4. Arquitetura proposta (v1)

```
            ┌──────────────────────────────┐
            │  Solana WS (logsSubscribe)   │  Pump + PumpSwap (+ PumpFees)
            └──────────────┬───────────────┘
                           │ log lines
                    ┌──────▼───────┐
                    │   Decoder    │  Program data: → eventos (valor, creator, mint)
                    └──────┬───────┘
                           │ claim candidato (valor ≥ 10 SOL)
                    ┌──────▼───────┐
                    │  Tx Enricher │  getParsedTransaction → sweep → mint(s)
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐      ┌─────────────┐
                    │ Market Data  │─────▶│ DexScreener │ (+ RPC bonding curve)
                    └──────┬───────┘      └─────────────┘
                           │ mcap por mint
                    ┌──────▼───────┐
                    │   Filters    │  mcap ≤ 500k · tipo · dedupe · cooldown
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Telegram    │  sendMessage (grupo)
                    └──────────────┘
```

Módulos: `ws-client` (reconnect/heartbeat), `decoder` (discriminadores/eventos), `enricher` (tx → mints),
`market` (mcap + cache), `filters` (regras), `telegram` (formatação/envio/retry), `state` (SQLite ou JSON:
assinaturas vistas, cooldown por mint, cursor), `health` (heartbeat + `/status`).

### 4.1 Filtro (pseudocódigo)

```ts
onClaimEvent(ev):
  if ev.err or seen(ev.sig): return
  if ev.type not in ALLOWED_TYPES: return          // exclui cashback/social/sweep
  if ev.amountLamports < MIN_CLAIM_SOL * 1e9: return
  tx = getParsedTransaction(ev.sig)
  mints = findSweptMints(tx) ∪ ev.mint            // sweep → base_mint / pool → mint
  if mints.empty: log("sem atribuição"); return
  for mint in mints:
     mc = marketCap(mint)                          // cache 60s
     if mc <= MAX_MCAP and not coolingDown(mint):
        sendTelegram(card(ev, mint, mc, mints))
        cooldown(mint, 30min)
  markSeen(ev.sig)
```

### 4.2 Dedupe e estado

- `seen_signatures`: set persistido (últimas ~5k) — WebSocket pode reenviar.
- `cooldown_por_mint`: evita 4 alertas do mesmo dev varrendo o mesmo token em 10 min.
- `cursor`: não existe backfill no WS, mas persistir o último slot ajuda a diagnosticar gaps.
- reinício: carregar estado do disco, nunca "replay" do que já foi enviado.

### 4.3 Resiliência

- reconnect com backoff + heartbeat (se 90 s sem evento, reconecta — o firehose nunca fica mudo).
- timeout e retry no Telegram (429 → respeitar `retry_after`).
- log estruturado + arquivo rotativo; alerta no próprio grupo se o bot cair/voltar.
- mensagem de boot: "bot online, N eventos/min, últimos 24h: X alertas".

---

## 5. Telegram

1. `@BotFather` → `/newbot` → token.
2. Criar o grupo, adicionar o bot **como membro** (em grupo não precisa ser admin; em canal precisa).
3. `chat_id`: `-100…` (grupo). Pegar com `getUpdates` após mandar uma mensagem no grupo, ou `@userinfobot`.
4. `sendMessage` com `parse_mode: HTML`, `link_preview_options: { is_disabled: true }`.
5. Limites: ~30 msg/s global, ~20 msg/min por grupo. Com filtro agressivo não é problema; ainda assim,
   fila + rate limit no sender.
6. Se o grupo tiver **tópicos**, `message_thread_id` para postar no tópico certo.

Card sugerido:

```
🟢 CLAIM 12.4 SOL  ·  há 3s
$TICKER — Nome
MC $412K (≤500K ✔)  ·  dev 8mNp…4rWz
Tipo: collect_creator_fee_v2 · 1 token no tx
CA 7xKX…p3Bz
Gráfico · Axiom · GMGN · TX
```

---

## 6. Rodar 24/7

**No PC (Windows)** — o que você pediu (início manual):
- `start.bat` que sobe o processo e abre o console com log; você fecha a janela ou Ctrl+C para parar.
- estado em `data/` para não repetir alerta ao reiniciar.
- opcional (depois): agendar no Task Scheduler para subir no logon, ou instalar como serviço com NSSM.
- **não** deixar o PC suspender: `powercfg /change standby-timeout-ac 0` (se suspender, o WS morre e os
  claims desse intervalo se perdem — não há backfill no WebSocket).
- rede instável: reconnect cobre; se cair internet, o gap é perdido.

**VPS** (mais confiável que PC): 1 vCPU/1 GB basta; roda em Docker ou systemd; você não depende do PC ligado.
Se a ideia é 24/7 de verdade, VPS é o caminho — em PC, "enquanto estiver ligado" é o limite real.

---

## 7. Custos e riscos

- **RPC**: o firehose (~100 tx/s por programa) não roda em plano grátis com estabilidade. Precisa de
  provedor com WS decente (Helius/QuickNode/Triton e similares). Medir consumo no spike antes de contratar.
- **Mudanças de programa**: a pump.fun mexeu no layout em out/2026 (v2/v3, sweep, sharing). O decoder
  tem que ser tolerante a campos extras e a novos discriminadores.
- **Semântica**: claim permissionless + vault por dev ⇒ alerta pode ser "agregado" e executado por terceiro.
- **Rate limit DexScreener** se muitos claims repetidos → cache obrigatório.
- **ToS**: uso de APIs de terceiros e do Telegram (sem spam).
- **Risco de produto**: o filtro pode ser raro demais ou barulhento demais; medir antes.

---

## 8. Plano de validação (1 hora, antes de escrever o bot)

Objetivo: responder com dados, não com achismo.

1. Assinar logs de Pump+PumpSwap por 60 min e **só contar**, sem notificar:
   - claims/hora por tipo;
   - distribuição de valores (p50/p90/p99);
   - % com valor ≥ 10 SOL;
   - desses, % com mcap ≤ 500k (DexScreener);
   - % sem mint atribuível.
2. Testar DexScreener em 20 mints aleatórios de claim: latência, `marketCap` presente, divergência vs
   bonding curve.
3. Medir o RPC: msgs/s, banda, reconexões, custo estimado/mês.

Critério de go: existir ≥ ~2–5 alertas/dia com os filtros atuais. Se der 0, ajustar limiar (ex.: 5 SOL)
ou incluir graduados.

---

## 9. Decisões fechadas (20/10) e o que resta

| # | Decisão | Valor |
|---|---|---|
| 1 | Terminal de referência | **Axiom** |
| 2 | Escopo | **Qualquer claim** (curva ou pós-graduação) abaixo do teto de mcap |
| 3 | Market cap | **USD**, teto **configurável** (500k = default) |
| 4 | Claim mínimo | **10 SOL** (configurável) |
| 5 | Execução | **PC ligado**, início manual; sem VPS por enquanto |
| 6 | Destino | **grupo do Telegram** |

Ainda em aberto (não bloqueiam o desenho):

- **Conteúdo do card**: nome/símbolo, mcap, dev, valor, links (Axiom/TX). Quer algo além disso
  (ex.: histórico do dev, quantos tokens ele tem, tempo desde o último claim)?
- **Tokens pareados em USDC**: ignorar na v1 ou converter para SOL?
- **RPC**: você já tem conta em Helius/QuickNode (ou similar)? É a única peça externa que falta para rodar.

---

## 10. Referências

- pump.fun docs — Collect Creator Fee: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md
- pump.fun docs — Fee sweeps: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/SWEEP_FEES.md
- pump.fun docs — Creator fee README: https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_CREATOR_FEE_README.md
- pump.fun docs — repo/IDL: https://github.com/pump-fun/pump-public-docs
- PumpPortal — Claim creator fees: https://pumpportal.fun/creator-fee/
- PumpPortal — Data API: https://pumpportal.fun/data-api/real-time/
- Referência de decode (open source): https://github.com/nirholas/pumpfun-claims-bot
- Bitquery — Solana Instructions API: https://docs.bitquery.io/docs/blockchain/Solana/solana-instructions/
- NoLimitNodes — PumpFun `collect_creator_fee_event`: https://nolimitnodes.com/products/program-streams/pump_fun/collect_creator_fee_event
- DexScreener API: https://docs.dexscreener.com/api/reference
- Helius — Webhooks/transaction types: https://www.helius.dev/docs/webhooks/transaction-types
