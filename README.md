# ClaimBot — claim da pump.fun no Telegram

Manda no seu grupo do Telegram quando um dev saca a creator fee (o "claim" do gráfico do Axiom),
respeitando dois filtros: valor do claim e market cap máximo.

Roda **na nuvem do GitHub, de graça**, ~23h por dia. Seu PC não roda nada.

---

## Como ligar

### 1. Coloque o bot no grupo
Adicione o bot (o @usuario criado no BotFather) ao seu grupo do Telegram.
O bot descobre o grupo sozinho — não precisa informar chat id.

### 2. Configure o token
No repositório: **Settings → Secrets and variables → Actions → New repository secret**

| Nome | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token do @BotFather |

### 3. Ligue
**Actions → claimbot → Run workflow**.
Em ~30 s chega **"ClaimBot online"** no grupo.

Daí em diante roda sozinho: cada execução dura 5h59 e o cron dispara a cada 6h,
então o buraco entre um ciclo e outro é de ~1 minuto (o GitHub não deixa uma execução passar de 6h).

---

## Filtros

**Settings → Secrets and variables → Actions → Variables → New variable**

| Variável | Padrão | Para que serve |
|---|---|---|
| `MIN_CLAIM_SOL` | `10` | valor mínimo do claim |
| `MAX_MCAP_USD` | `500000` | market cap máximo em USD |
| `WATCH_AMM` | `true` | `false` = ignora tokens graduados |
| `ALERT_TYPES` | `collect_creator_fee,collect_coin_creator_fee` | quais claims viram alerta. `distribute_creator_fees` = claim de recipiente (fee sharing), desligado por padrão |

Vale na próxima execução (a cada 6 h). Para mudar na hora: Actions → Run workflow.

O card traz **nome do token, valor do claim, CA e market cap**, mais link do Axiom e da TX.

---

## Como funciona

```
logs da Pump + PumpSwap (WebSocket)
   └─ reconhece os 3 eventos de claim      → valor em SOL
        ├ collect_creator_fee      (curva)
        ├ collect_coin_creator_fee (pós-graduação)
        └ distribute_creator_fees  (fee sharing) → valor vem dos saldos da tx
   └─ acha o token pelo sweep_creator_fee na mesma transação
   └─ market cap + nome no DexScreener
   └─ filtros → Telegram
```

Dedupe por assinatura, cooldown por token, reconexão automática.

---

## Limitações (honestas)

- O GitHub pode **atrasar o início de cada ciclo** em alguns minutos; há janelas de ~10–15 min
  por dia em que o bot está desligado.
- Repositório parado por 60 dias → o GitHub desativa o cron; **Actions → Run workflow** reativa.
- Sem backfill: claim na janela desligada não é recuperado.
- Claims pagos em outro token (quote ≠ SOL) são ignorados.
- Um claim pode varrer vários tokens do mesmo dev; o card lista até 8 e o valor é o total.

---

## Rodar localmente (só para testar)

Precisa de Node.js 20+ e de um `.env` (copie de `.env.example`).

```bat
node src/index.js --test
node src/index.js --dry --for 60
```

O modo local baixa o fluxo do programa (~2–6 GB/h). Para uso contínuo, use a nuvem.

## Testes

```bat
npm test
```

---

## Estrutura

```
src/
  index.js       entrada, CLI (--dry, --test, --for)
  config.js      .env / variáveis de ambiente
  bot.js         websocket, fila, filtros, alertas
  decoder.js     eventos de claim (discriminadores + layout)
  attribution.js sweep → token
  market.js      DexScreener (nome, símbolo, market cap) com cache
  format.js      card HTML
  telegram.js    envio com retry/429
  state.js       dedupe + cooldown em disco
.github/workflows/claimbot.yml   execução na nuvem
test/            node:test
```
