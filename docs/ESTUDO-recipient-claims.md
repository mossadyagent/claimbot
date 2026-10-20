# Estudo: claims de "recipient" (X/Twitter) — BANKR e USEPAID

Status: **estudo, nada implementado**. Data: 20/10/2026.

---

## 1. O que o print do Axiom mostra

O Axiom separa os claims de um token em duas abas:

- **Recipient Claims (1)** — claim pago a um **recipiente vinculado a uma conta X** (no print:
  "claimed by **For Our Futures** ✓", conta verificada). Valor: **US$ 9.435,65**.
- **Fee Claims (40)** — os claims normais de creator fee (o que o nosso bot já vê hoje).

Ou seja: o Axiom trata como eventos diferentes "o dev sacou creator fee" e "o recipiente social
(conta X) sacou a parte dele". O BANKR e o USEPAID caem no segundo grupo — é o que você descreveu
("o Usepaid manda fee pra @ de twitter").

---

## 2. Como isso existe on-chain (o que já sabemos)

A pump.fun tem **fee sharing**: a creator fee de um token pode ser dividida entre vários
recipientes, inclusive **contas sociais**. Isso vive no **programa Pump Fees**:

| Item | Valor |
|---|---|
| Programa | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |
| Instrução | `claim_social_fee_pda` (`e115fb85a11ec7e2`) e `_v2` (`114df0863abc3595`) |
| Evento | `SocialFeePdaClaimed` (`3212c141edd2eaec`) |
| Estado por token | conta `SharingConfig` (guarda beneficiários e PDAs sociais) |

O evento carrega, em princípio: **plataforma** (enum; `2` = GitHub, segundo o SDK de terceiros),
**user id** (o handle/ID da conta social), **valor pago** e o **total acumulado**. O `mint` **não**
vem no evento — igual ao claim normal, precisa ser resolvido.

---

## 3. Medições feitas agora (para dimensionar)

Assinei os logs do programa Pump Fees por 45 s:

- **54.502 mensagens em 45 s ≈ 1.200 msg/s** — mais pesado que o programa da pump (~500/s).
- **0 eventos `SocialFeePdaClaimed`** e **0 linhas `Instruction: ClaimSocialFeePda`** nesse período.

Conclusões parciais:

1. Claim social é **raro** (o print mostra 1 contra 40 claims normais).
2. Para capturar 1 evento raro, o preço é um **terceiro stream de ~1.200 msg/s** (~2,5 MB/s), ou seja,
   o tráfego do bot mais que dobraria.
3. O marcador `Instruction: ...` **não apareceu** — o decoder teria que ser feito pelo evento
   (`Program data:`), não pelo log de instrução.

---

## 4. O problema de atribuição (o ponto difícil)

Claim social paga uma **PDA social** (uma conta por handle), não um token. Para saber **de qual
token** veio o dinheiro é preciso o mapa `PDA social → mint`, que só existe na conta `SharingConfig`
de cada token. Opções:

| Estratégia | Custo | Comentário |
|---|---|---|
| Índice completo (`getProgramAccounts` de todas as `SharingConfig`) | uma leitura pesada no boot (~148 mil contas, segundo projeto de referência) | dá o mapa certo; precisa de RPC bom |
| Resolver na hora, pela própria transação | 1 leitura por claim | depende de a tx trazer a `SharingConfig` |
| Confiar no evento | zero | não traz o mint |

O projeto open source `pumpfun-claims-bot` resolve isso justamente com o índice de ~148 mil contas
mais atualização incremental por evento (`CreateFeeSharingConfig`, `UpdateFeeShares`).

---

## 5. BANKR e USEPAID — o que são

**USEPAID (PAID)** — token, não plataforma:
`4fBiGYVbKJGZybXutS8Q8C1YhtjkbeZ8DsBxWjETpaid`, ~US$ 2,4 mil de mcap, já na PumpSwap.
Se as fees dele vão para um @ do X, o claim correspondente é **social** (Pump Fees), não o claim
normal que o bot vê hoje.

**BANKR** — plataforma de agente de IA que lança tokens. No Solana ela usa a **Raydium**, não a
pump. Existem dois tokens com esse nome no mercado:
`4BmaxxckzuAnFZANYP8uZ4MQUBLoKBHxbx1xbZSDbank` ("Bankr on Sol", ~US$ 11 mil) e
`ssTkdAm64ZCY6GFP8Wq2iYp4cpGzsqNu37RNnYWpump` ("Bankr Bot", ~US$ 1,9 mil).

Consequência: claims de tokens lançados pelo BANKR **não passam pelo programa da pump** — passam pelo
programa da Raydium (LaunchLab/CPMM), que tem instrução de claim própria. Isso é uma integração
separada, com discriminadores e layout diferentes.

---

## 6. O que falta confirmar antes de construir

1. **Uma transação real de claim social com plataforma X**: pegar 1 exemplo e decodificar
   (plataforma, user id, valor, e se a tx traz a `SharingConfig`).
2. **Qual número é X** no enum de plataforma (o SDK de terceiros cita `2` = GitHub; X deve ser outro).
3. **Taxa real**: quantos claims sociais por hora (45 s deram 0 — precisa de janela maior).
4. **BANKR**: confirmar qual programa da Raydium eles usam e se o claim tem destinatário social.
5. **Custo**: o stream do Pump Fees (~1,2 mil msg/s) cabe no mesmo plano? Se não, a alternativa é
   um indexador filtrado.

---

## 7. Desenho provável (quando for construir)

```
stream Pump Fees (agora também)
  └─ evento SocialFeePdaClaimed
       ├─ plataforma == X
       ├─ valor ≥ mínimo
       ├─ resolve PDA → mint (índice SharingConfig, mantido em memória)
       ├─ mcap do mint (DexScreener)
       └─ card: "claim de recipiente (@handle) · valor · token · CA · mcap"

+ (opcional, separado) stream Raydium LaunchLab para tokens do BANKR
```

O card seria parecido com o atual, com uma linha a mais: **quem recebeu (@handle)** — que é
justamente a informação que o Axiom mostra e o nosso bot hoje não tem.

---

## 8. Resumo

- O que o Axiom chama de **Recipient Claim** é claim de **fee sharing social** (Pump Fees), não o
  claim normal de creator fee.
- Dá para adicionar, mas custa um **terceiro stream pesado** e um **índice de SharingConfig**.
- BANKR é caso à parte (Raydium), com programa e instruções próprios.
- Antes de codar: achar 1 tx real de claim social com X e medir a frequência.
