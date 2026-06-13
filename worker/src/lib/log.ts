export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  correlationId?: string;
  userId?: string;
  sessionKey?: string;
  requestId?: string;
  traceId?: string;
  username?: string;
  sessionTitle?: string;
  platform?: string;
  cfRay?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug: (event: string, extra?: Record<string, unknown>) => void;
  info: (event: string, extra?: Record<string, unknown>) => void;
  warn: (event: string, extra?: Record<string, unknown>) => void;
  error: (event: string, extra?: Record<string, unknown>) => void;
}

export function createLogger(source: string, ctx: LogContext = {}): Logger {
  const base: Record<string, unknown> = {
    service_name: 'construct-app-registry',
    source,
    ...ctx,
  };

  function write(level: LogLevel, event: string, extra?: Record<string, unknown>): void {
    const payload = {
      ...base,
      level,
      event,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    if (level === 'debug') console.debug(JSON.stringify(payload));
    else if (level === 'info') console.log(JSON.stringify(payload));
    else if (level === 'warn') console.warn(JSON.stringify(payload));
    else console.error(JSON.stringify(payload));
  }

  return {
    debug: (event, extra) => write('debug', event, extra),
    info: (event, extra) => write('info', event, extra),
    warn: (event, extra) => write('warn', event, extra),
    error: (event, extra) => write('error', event, extra),
  };
}

export function configureWorkerLogging(_env?: unknown): void {
  // no-op — using CF Workers Logs + OTLP export
}

export function formatDevLogLine(record: { message: string; level: string; timestamp: Date; category?: string[] }): string {
  const ts = record.timestamp.toISOString();
  const level = record.level.toUpperCase();
  const cat = record.category?.join('.') ?? '';
  return `${ts} [${level}] ${cat ? `[${cat}] ` : ''}${record.message}`;
}
