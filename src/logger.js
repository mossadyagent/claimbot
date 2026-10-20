const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const stamp = () => new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const write = (name, stream, args) => {
    if (LEVELS[name] < min) return;
    stream(`[${stamp()}] ${name.toUpperCase().padEnd(5)} ${args.join(' ')}`);
  };
  return {
    debug: (...a) => write('debug', console.log, a),
    info: (...a) => write('info', console.log, a),
    warn: (...a) => write('warn', console.warn, a),
    error: (...a) => write('error', console.error, a),
  };
}
