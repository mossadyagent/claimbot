# SPEC v1 — Claim Bot (pump.fun → Telegram)

Status: **implementado** (v1). Para uso, veja [README.md](README.md).
Base conceitual: [ESTUDO-claim-bot.md](ESTUDO-claim-bot.md).

---

## 1. Escopo

Rodar no PC (Windows), iniciado manualmente, e mandar no grupo do Telegram **um alerta por claim de
creator fee** que satisfaça **ao mesmo tempo**:

- valor do claim ≥ `MIN_CLAIM_SOL` (default **10**);
- market cap do token no momento do claim ≤ `MAX_MCAP_USD` (default **500000**);
- tipo de claim ∈ creator fee (curva, AMM ou sharing) — nunca cashback, social fee, sweep ou transferência.

Vale para token **na curva e pós-graduação**. Sem backfill: só o que acontecer com o bot rodando.

Fora de escopo (v1): comandos no Telegram, banco de dados, VPS, backfill histórico, short/execução de trade.

---

## 2. Configuração (`.env`)

| Variável | Default | Para que serve |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | token do @BotFather |
| `TELEGRAM_CHAT_ID` | — | id do grupo (`-100…`) |
| `MIN_CLAIM_SOL` | `10` | corte inferior do claim |
| `MAX_MCAP_USD` | `500000` | teto de market cap |
| `MAX_MCAP_SOL` | *(vazio)* | alternativa em SOL; se preenchido, tem prioridade |
| `SOLANA_RPC_URL` | — | HTTP RPC |
| `SOLANA_WS_URL` | derivado | WebSocket (`wss://…`) |
| `DRY_RUN` | `false` | `true` = não envia, só loga candidatos |
| `COOLDOWN_MIN` | `30` | silêncio por token depois de um alerta |
| `LOG_LEVEL` | `info` | `debug` mostra todo claim decodificado |

---

## 3. Pipeline

```
WS logs (Pump 6EF8rr…, PumpSwap pAMMBa…, PumpFees pfeeUx…)
  └─ decoder: Program data: → evento
       ├ CollectCreatorFeeEvent      { timestamp, creator, creator_fee }
       ├ CollectCoinCreatorFeeEvent  { …, coin_creator_fee }
       └ DistributeCreatorFeesEvent  { mint, distributed }
  └─ corte barato: valor < MIN_CLAIM_SOL → descarta (sem RPC)
  └─ dedupe por assinatura
  └─ enricher: getParsedTransaction → mints
  └─ market: mcap por mint (cache 60 s)
  └─ filtros: mcap, tipo, cooldown, atribuição
  └─ telegram: card HTML
  └─ state: marca assinatura + cooldown
```

### 3.1 De onde sai o mint

| Instrução de claim | Mint vem de |
|---|---|
| `distribute_creator_fees` / `_v2` | accounts[0] / accounts[1] (e do próprio evento) |
| `collect_creator_fee` / `_v2` | `sweep_creator_fee` na mesma tx → accounts[2] = `base_mint` |
| `collect_coin_creator_fee` | `sweep_creator_fee` (PumpSwap) na mesma tx → accounts[2] = `pool` → decode `Pool.base_mint` |

Se a tx tiver **N sweeps**, o card mostra N tokens e marca "valor agregado"; o alerta passa se **algum**
estiver abaixo do teto. Se não houver sweep e o evento não trouxer mint, o claim é logado como
`sem_atribuicao` e **não** notifica (medimos a frequência no dry-run).

### 3.2 Market cap

1. `GET https://api.dexscreener.com/latest/dex/tokens/{mint}` → escolhe o par de maior liquidez →
   `marketCap` (fallback `fdv`). Cache 60 s por mint.
2. Se não houver par (token recém-criado na curva): `getAccountInfo` da PDA `["bonding-curve", mint]` →
   `mcapSol = virtual_sol_reserves * token_total_supply / virtual_token_reserves` → × preço do SOL.
3. Preço do SOL: DexScreener (par WSOL/USDC de maior liquidez), cache 60 s.

Offset do `BondingCurve` (conferir no IDL antes de codar): disc 8 · vtr 8 · vsr 8 · rtr 8 · rsr 8 ·
supply 8 · complete 1 → supply em `40..48`, `complete` em `48`.

---

## 4. Card no Telegram

```
🟢 CLAIM · 12.43 SOL ($2.1K)
$TICKER — Nome do Token
MC $412.0K ≤ 500K ✔  ·  🎓 graduado
👤 dev 8mNp…4rWz
🧾 collect_creator_fee_v2 · 1 token na tx
CA 7xKX…p3Bz
Axiom · DexScreener · pump.fun · TX
⏱ 3s após o claim
```

- `parse_mode: HTML`, preview desligado, valores escapados.
- Valores em USD opcionais (usa o mesmo preço de SOL do cache).
- Se `N > 1` token: lista cada um com mcap e marca quais passaram no filtro.

---

## 5. Estrutura de arquivos

```
ClaimBot/
├─ src/
│  ├─ index.ts        # boot, wiring, shutdown
│  ├─ config.ts       # .env + validação
│  ├─ logger.ts
│  ├─ ws.ts           # onLogs, heartbeat, reconnect, backoff
│  ├─ decoder.ts      # discriminadores + eventos (tolerante a campos extras)
│  ├─ enrich.ts       # tx → mints (sweeps / pool)
│  ├─ market.ts       # mcap + preço SOL + cache
│  ├─ filters.ts      # regras puras (testáveis)
│  ├─ card.ts         # HTML
│  ├─ telegram.ts     # sendMessage, retry 429, fila
│  └─ state.ts        # seen sigs + cooldowns (JSON atômico)
├─ src/__tests__/
├─ data/              # estado (gitignored)
├─ logs/
├─ .env.example
├─ start.bat
└─ package.json
```

Dependências: `@solana/web3.js`, `bs58`, `dotenv`. Dev: `typescript`, `tsx`, `vitest`, `@types/node`.
Sem dependência nativa (estado em JSON com escrita atômica: temp + rename).

---

## 6. Rodar

```bat
npm install
copy .env.example .env   :: preencher token, chat id e RPC
npm run build
start.bat
```

`start.bat` → `node dist/index.js`, console aberto com log, Ctrl+C encerra.
No boot, o bot manda mensagem "online" no grupo (confirma token/chat id e serve de teste).

---

## 7. Testes (obrigatório antes de dizer que está pronto)

1. **Unit — decoder**: fixtures de logs reais (coletar 5–10 txs no dry-run) → valor, creator, tipo.
2. **Unit — atribuição**: tx com 1 sweep, com N sweeps, sem sweep.
3. **Unit — filtros**: bordas (9.99 vs 10 SOL; 499.999 vs 500.001; cooldown; duplicata).
4. **Unit — card**: escaping de nome com `<`/`&`, link, N tokens.
5. **Integração — dry-run ao vivo (30–60 min)**: contadores de claims/min, % ≥ 10 SOL, % ≤ 500k,
   % sem atribuição. Sem enviar nada.
6. **E2E**: com `DRY_RUN=false`, forçar um claim real elegível e conferir latência no grupo.
7. **Resiliência**: derrubar o Wi-Fi por 30 s → reconnect < 10 s; reiniciar → sem alerta duplicado.

Critério de aceite: claim elegível sai no grupo em **≤ 5 s**; nenhum alerta duplicado; 2 h rodando sem
vazamento de memória; nenhum alerta de cashback/social/sweep.

---

## 8. Calibração (primeira execução)

O par 10 SOL + 500k pode ser raro. Sequência:

1. Rodar 1 h em `DRY_RUN=true` e olhar o relatório (contadores já previstos no log).
2. Se der menos de ~2 alertas/dia: baixar `MIN_CLAIM_SOL` (ex.: 5) ou subir `MAX_MCAP_USD`.
3. Se der barulho demais: subir o mínimo ou usar `COOLDOWN_MIN`.

---

## 9. Riscos v1 (e mitigação)

| Risco | Mitigação |
|---|---|
| Evento de claim não aparece no log em algum caminho | contador `sem_evento` no dry-run; fallback: diff de saldo do signer |
| Claim sem sweep (atribuição impossível) | logar e medir; v2 com índice dev→tokens |
| Offset do `Pool`/`BondingCurve` mudar | decode defensivo por tamanho; validação contra `idl/*.json` |
| DexScreener 429 | cache 60 s + fila 1 req/s |
| PC suspender | `powercfg` documentado no README; sem backfill |
| WS morrer em silêncio | heartbeat 90 s → reconnect |

---

## 10. Ordem de construção

1. Skeleton + config + logger + `start.bat`.
2. WS + decoder com contadores em dry-run (valida a premissa do log).
3. Enricher (sweeps → mints) + market (mcap/SOL).
4. Filtros + estado (dedupe/cooldown).
5. Telegram + card + retry.
6. Suíte de testes + rodada de calibração.

Passo 2 é o **gate**: se os eventos não aparecerem como esperado, o plano B é o índice pago (Bitquery),
e o resto do bot continua igual — só o módulo de entrada muda.
