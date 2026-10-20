export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatAmount(sol) {
  if (sol >= 100) return sol.toFixed(0);
  if (sol >= 1) return sol.toFixed(2);
  if (sol >= 0.01) return sol.toFixed(3);
  return sol.toFixed(4);
}

export function formatMcap(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return '?';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

const short = (mint) => `${mint.slice(0, 6)}…${mint.slice(-4)}`;

/**
 * Alert card. One token: full block. Several tokens: one line each, the winning
 * market caps marked, and the CA of the first qualifying token called out.
 */
export function formatClaimCard(claim) {
  const { amountSol, solUsd, tokens, signature, mcapLimit } = claim;
  const usd = solUsd > 0 ? ` <i>($${Math.round(amountSol * solUsd).toLocaleString('en-US')})</i>` : '';
  const lines = [`🟢 <b>CLAIM ${formatAmount(amountSol)} SOL</b>${usd}`];

  const winners = tokens.filter((t) => t.qualifies);
  const primary = winners[0] ?? tokens[0];

  if (tokens.length === 1) {
    const t = tokens[0];
    const name = t.name || t.symbol || 'Token';
    lines.push(`<b>${escapeHtml(name)}</b>${t.symbol ? ` <i>(${escapeHtml(t.symbol)})</i>` : ''}`);
    lines.push(`MC: <b>${formatMcap(t.mcapUsd)}</b>${limitLabel(t.mcapUsd, mcapLimit)}`);
    lines.push(`<code>${t.mint}</code>`);
  } else {
    lines.push(`<b>${tokens.length} tokens na mesma transação</b> (valor agregado)`);
    for (const t of tokens.slice(0, 6)) {
      const name = escapeHtml(t.name || t.symbol || short(t.mint));
      lines.push(`${t.qualifies ? '✅' : '▫️'} ${name} — ${formatMcap(t.mcapUsd)}`);
    }
    if (tokens.length > 6) lines.push(`… +${tokens.length - 6}`);
    if (primary) lines.push(`<code>${primary.mint}</code>`);
  }

  const links = [
    primary ? `<a href="https://axiom.trade/t/${primary.mint}">Axiom</a>` : null,
    `<a href="https://solscan.io/tx/${signature}">TX</a>`,
  ].filter(Boolean);
  lines.push(links.join(' · '));
  return lines.join('\n');
}

function limitLabel(mcap, limit) {
  if (!Number.isFinite(mcap) || mcap <= 0) return '';
  if (Number.isFinite(limit) && mcap <= limit) return ` ≤ ${formatMcap(limit)} ✅`;
  return '';
}
