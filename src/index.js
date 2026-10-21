import { loadConfig, maskConfig } from './config.js';
import { createLogger } from './logger.js';
import { Bot } from './bot.js';
import { Telegram } from './telegram.js';
import { formatClaimCard } from './format.js';

const argv = process.argv.slice(2);
const forIndex = argv.indexOf('--for');
const runSeconds = forIndex >= 0 ? Number(argv[forIndex + 1]) : 0;

let cfg;
try {
  cfg = loadConfig(argv);
} catch (err) {
  console.error(`\n[erro] ${err.message}\n`);
  console.error('Copie o .env.example para .env e preencha o token e o chat id.\n');
  process.exit(1);
}

const log = createLogger(cfg.logLevel);

// ── --test: envia um card de exemplo para confirmar que o Telegram esta ok ──
if (argv.includes('--test')) {
  if (!cfg.telegramToken) {
    log.error('configure TELEGRAM_BOT_TOKEN');
    process.exit(1);
  }
  const telegram = new Telegram(cfg.telegramToken, cfg.telegramChatId, log);
  if (!telegram.chatId) await telegram.discoverChat();
  if (!telegram.chatId) {
    log.error('o bot nao esta em nenhum grupo. Adicione o bot ao grupo e rode de novo.');
    process.exit(1);
  }
  const html = formatClaimCard({
    amountSol: 12.34,
    solUsd: 170,
    signature: 'teste',
    mcapLimit: cfg.maxMcapUsd,
    tokens: [
      {
        mint: 'CZeDLLXqSU8MFzvpcHBYDzn7BinUNmTfnrENd8gjpump',
        name: 'Hoard Capital',
        symbol: 'HOARD',
        mcapUsd: 412000,
        qualifies: true,
      },
    ],
  });
  const ok = await telegram.send(html);
  log.info(ok ? 'mensagem de teste enviada; confira o grupo' : 'falhou — veja o erro acima');
  process.exit(ok ? 0 : 1);
}

const info = maskConfig(cfg);
log.info('ClaimBot — alertas de claim da pump.fun no Telegram');
log.info(`modo: ${info.modo} · filtro: >= ${info.minClaimSol} SOL · mcap <= ${info.maxMcap} · cooldown ${info.cooldownMin}min`);
log.info(`telegram: ${info.chat} · rpc: ${cfg.rpcUrls[0]}`);
if (runSeconds > 0) log.info(`execucao de teste: encerra em ${runSeconds}s`);

const bot = new Bot(cfg, log);

async function shutdown(code = 0) {
  bot.stop();
  log.info(bot.summary());
  if (!cfg.dryRun && bot.telegram && cfg.cycleSummary) {
    const mins = Math.round((Date.now() - bot.stats.startedAt) / 60000);
    await bot.telegram
      .send(`⏱ <b>Ciclo encerrado</b> · ${mins} min\nclaims vistos: ${bot.stats.claims} · alertas: ${bot.stats.alerts}`)
      .catch(() => {});
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => {
  log.info('encerrando...');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (err) => log.error(`promise rejeitada: ${err?.message ?? err}`));
process.on('uncaughtException', (err) => log.error(`excecao: ${err?.message ?? err}`));

bot.onBudgetExhausted = () => shutdown(0);
bot.start();
if (runSeconds > 0) setTimeout(() => shutdown(0), runSeconds * 1000);
