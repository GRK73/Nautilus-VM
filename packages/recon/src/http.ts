export const DEFAULT_UA = 'Mozilla/5.0 (compatible; NautilusVM/0.1; lost-media-archival)';
export const DEFAULT_TIMEOUT = 12_000;

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

/** fetch() with an abort timeout and a default UA. */
export async function fetchWithTimeout(url: string, opts: HttpOptions = {}): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      method: opts.method ?? 'GET',
      body: opts.body,
      headers: { 'user-agent': DEFAULT_UA, ...opts.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Strip tags + collapse whitespace for snippet text. */
export function plainText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
