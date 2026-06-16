/**
 * Zero-dependency HTML processing. Not a full parser — deliberately lightweight,
 * good enough to turn a page into searchable text, a title, a summary, and links.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const key = ent.toLowerCase();
    return key in NAMED_ENTITIES ? NAMED_ENTITIES[key]! : m;
  });
}

/** Strip markup and collapse whitespace into readable plain text. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v\r]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || m[1] === undefined) return null;
  const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

/** Pull <meta name="description"> or og:description. */
export function extractMetaDescription(html: string): string | null {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metas) {
    const name = (tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1] ?? '').toLowerCase();
    if (name === 'description' || name === 'og:description') {
      const c = tag.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i)?.[1];
      if (c) {
        const v = decodeEntities(c).replace(/\s+/g, ' ').trim();
        if (v.length) return v;
      }
    }
  }
  return null;
}

/** Resolve outbound <a href> links to absolute URLs (deduped). */
export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] ?? '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    try {
      out.add(new URL(href, base).toString());
    } catch {
      /* skip invalid */
    }
  }
  return [...out];
}

/** Compose a compact summary: title — description — leading body text. */
export function summarize(
  title: string | null,
  description: string | null,
  text: string,
  max = 400,
): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  if (description) parts.push(description);
  const prefix = parts.join(' — ');
  const sep = parts.length ? ' — ' : '';
  const remaining = max - prefix.length - sep.length - 1; // reserve 1 for the ellipsis
  if (remaining > 20 && text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length) {
      const truncated = flat.length > remaining;
      parts.push(flat.slice(0, remaining).trim() + (truncated ? '…' : ''));
    }
  }
  return parts.join(' — ');
}
