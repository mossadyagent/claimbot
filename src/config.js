import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toWs(url) {
  return url.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(argv = process.argv.slice(2)) {
  const env = { ...parseEnvFile(join(ROOT, '.env')), ...process.env };
  const dryFlag = argv.includes('--dry') || argv.includes('--dry-run') || argv.includes('--test');

  const rpcUrls = toList(env.SOLANA_RPC_URLS || env.SOLANA_RPC_URL || PUBLIC_RPC);
  const wsUrls = toList(env.SOLANA_WS_URLS || env.SOLANA_WS_URL).length
    ? toList(env.SOLANA_WS_URLS || env.SOLANA_WS_URL)
    : rpcUrls.map(toWs);

  const cfg = {
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    minClaimSol: num(env.MIN_CLAIM_SOL, 10),
    maxMcapUsd: num(env.MAX_MCAP_USD, 500000),
    maxMcapSol: num(env.MAX_MCAP_SOL, 0),
    cooldownMin: num(env.COOLDOWN_MIN, 30),
    watchAmm: String(env.WATCH_AMM ?? 'true').toLowerCase() !== 'false',
    // Tipos de evento que viram alerta: claim do dev na curva, na AMM e a
    // distribuicao de fee sharing (que tambem paga o dev / os recipientes).
    // O valor vem do proprio evento em todos os tres.
    alertTypes: new Set(
      String(env.ALERT_TYPES || 'collect_creator_fee,collect_coin_creator_fee,distribute_creator_fees')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    // 0 = sem limite; acima disso o bot se desliga sozinho (protege internet/plano)
    maxSessionGb: Number(env.MAX_SESSION_GB) > 0 ? Number(env.MAX_SESSION_GB) : 0,
    startupMessage: String(env.STARTUP_MESSAGE ?? 'true').toLowerCase() !== 'false',
    rpcUrls,
    wsUrls,
    dryRun: dryFlag || String(env.DRY_RUN).toLowerCase() === 'true',
    logLevel: env.LOG_LEVEL || 'info',
    statePath: env.STATE_PATH || join(ROOT, 'data', 'state.json'),
    heartbeatMs: 90_000,
    // pump.fun programs
    pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    amm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    fees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  };

  if (!cfg.dryRun && !cfg.telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN e obrigatorio (ou use --dry).');
  }
  return cfg;
}

export function maskConfig(cfg) {
  const token = cfg.telegramToken ? `${cfg.telegramToken.slice(0, 6)}...${cfg.telegramToken.slice(-4)}` : '(nenhum)';
  return {
    modo: cfg.dryRun ? 'DRY-RUN (nao envia)' : 'AO VIVO',
    telegram: token,
    chat: cfg.telegramChatId || '(nenhum)',
    minClaimSol: cfg.minClaimSol,
    maxMcap: cfg.maxMcapSol > 0 ? `${cfg.maxMcapSol} SOL` : `$${cfg.maxMcapUsd}`,
    cooldownMin: cfg.cooldownMin,
    rpc: cfg.rpcUrls.map((u) => u.replace(/api-key=[^&]+/, 'api-key=***')),
    ws: cfg.wsUrls.map((u) => u.replace(/api-key=[^&]+/, 'api-key=***')),
  };
}
