/**
 * Agreement wording (FR20 §5.1) is stored as plain text with a small, safe
 * formatting syntax, rendered without HTML so nothing an administrator types
 * can run as script:
 *
 *   # Heading / ## Subheading
 *   - bullet point (or * bullet)
 *   1. numbered point
 *   **bold**, *italic*, [link text](https://example.org)
 *
 * Paragraphs are separated by a blank line. Only http(s) and mailto links are
 * kept; anything else is shown as plain text.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'heading'; level: 1 | 2; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] };

export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(h) ? h : null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]);
      flush();
      if (href) out.push({ type: 'link', href, children: parseInline(link[1]) });
      else out.push({ type: 'text', text: link[1] });
      i += link[0].length;
      continue;
    }
    const bold = /^\*\*(.+?)\*\*/.exec(rest);
    if (bold) {
      flush();
      out.push({ type: 'bold', children: parseInline(bold[1]) });
      i += bold[0].length;
      continue;
    }
    const italic = /^\*([^*\s][^*]*?)\*/.exec(rest);
    if (italic) {
      flush();
      out.push({ type: 'italic', children: parseInline(italic[1]) });
      i += italic[0].length;
      continue;
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

export function parseAgreementText(source: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const endPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
    para = [];
  };
  const endList = () => {
    if (list) blocks.push({ type: 'list', ...list });
    list = null;
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      endPara();
      endList();
      continue;
    }
    const heading = /^(#{1,2})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (heading) {
      endPara();
      endList();
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2, children: parseInline(heading[2]) });
    } else if (bullet || numbered) {
      endPara();
      const ordered = !!numbered;
      if (list && (list as { ordered: boolean }).ordered !== ordered) endList();
      if (!list) list = { ordered, items: [] };
      (list as { items: Inline[][] }).items.push(parseInline((bullet ?? numbered)![1]));
    } else {
      endList();
      para.push(line);
    }
  }
  endPara();
  endList();
  return blocks;
}
