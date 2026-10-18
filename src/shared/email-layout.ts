/**
 * The Scouts-branded email layout every email is sent in. An email is built
 * from five sections, always in this order:
 *
 *   {{ title }} {{ body }} {{ detail-card }} {{ thanks }} {{ footer }}
 *
 * Mail clients ignore most CSS, so everything is tables and inline styles, in
 * the Scouts brand palette and Nunito Sans (falling back to Arial where web
 * fonts don't load). Everything passed in here is already escaped HTML.
 */

const FONT = "'Nunito Sans',Arial,Helvetica,sans-serif";

export const EMAIL_COLOURS = {
  purple: '#7413dc',
  navy: '#003982',
  blue: '#006ddf',
  green: '#23a950',
  red: '#e22e12',
  pink: '#ffb4e5',
  yellow: '#ffe627',
  orange: '#ff912a',
  teal: '#088486',
  grey: '#5c5c5c',
} as const;

export type BadgeColour = keyof typeof EMAIL_COLOURS;

/** One body paragraph (lines already joined with <br>) or a call-to-action button. */
export type BodyBlock = { kind: 'para'; html: string } | { kind: 'button'; label: string; url: string };

export interface EmailSections {
  /** Status pill above the title; fixed per template. */
  badge?: { label: string; colour: BadgeColour };
  title: string;
  body: BodyBlock[];
  /** One card per entry, each a list of [label, value] rows; an empty card is hidden. */
  detailCards: [string, string][][];
  /** Lines of the sign-off; the last is bold. */
  thanks: string[];
  /** Lines of the footer; lines starting with # are bold. */
  footer: string[];
}

export interface LayoutOptions {
  /** Window title (the subject). */
  title: string;
  /** Inbox preview line. */
  preheader: string;
  /** Logo image URL from Settings. Blank means no logo yet. */
  logoUrl: string;
  venueName: string;
  /** Previews show where the logo will go while none is set. */
  showLogoPlaceholder?: boolean;
}

function badge(b: NonNullable<EmailSections['badge']>): string {
  const text = b.colour === 'yellow' || b.colour === 'pink' || b.colour === 'orange' ? '#000000' : '#ffffff';
  return `<p style="margin:0 0 16px 0;"><span style="display:inline-block;background:${EMAIL_COLOURS[b.colour]};color:${text};font-family:${FONT};font-weight:700;font-size:14px;line-height:20px;padding:6px 14px;border-radius:999px;">${b.label}</span></p>`;
}

function title(text: string): string {
  return `<h1 class="headline" style="margin:0 0 24px 0;font-family:${FONT};font-weight:900;font-size:36px;line-height:40px;color:${EMAIL_COLOURS.purple};">${text}</h1>`;
}

function para(html: string): string {
  return `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:17px;line-height:26px;color:#000000;">${html}</p>`;
}

/** A call-to-action button, with the link written out underneath for clients that block buttons. */
function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px 0;"><tr>
<td style="background:${EMAIL_COLOURS.purple};border-radius:999px;"><a href="${url}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-weight:800;font-size:17px;line-height:22px;color:#ffffff;text-decoration:none;">${label}</a></td>
</tr></table>
<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${EMAIL_COLOURS.grey};">Or copy this link into your browser:<br><a href="${url}" style="color:${EMAIL_COLOURS.purple};word-break:break-all;">${url}</a></p>`;
}

/** The pink panel of booking details. The first row is shown larger. */
function detailCard(rows: [string, string][]): string {
  if (!rows.length) return '';
  const cells = rows
    .map(([label, value], i) => {
      const pad = `${i === 0 ? 24 : 12}px 28px ${i === rows.length - 1 ? 24 : 0}px 28px`;
      const size = i === 0 ? 'font-weight:900;font-size:24px;line-height:30px' : 'font-weight:700;font-size:18px;line-height:26px';
      const heading = label ? `<div style="font-weight:700;font-size:13px;line-height:18px;color:#333333;">${label}</div>\n` : '';
      return `<tr><td style="padding:${pad};font-family:${FONT};">
${heading}<div style="${size};color:#000000;">${value}</div>
</td></tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLOURS.pink};border-radius:12px;margin:8px 0 24px 0;">
${cells}
</table>`;
}

function thanks(lines: string[]): string {
  if (!lines.length) return '';
  const html = lines.map((l, i) => (i === lines.length - 1 && lines.length > 1 ? `<strong>${l}</strong>` : l)).join('<br>');
  return `<p style="margin:8px 0 0 0;font-family:${FONT};font-size:17px;line-height:26px;color:#000000;">${html}</p>`;
}

function footer(lines: string[]): string {
  if (!lines.length) return '';
  const rows = lines
    .map((l, i) => {
      const weight = l.startsWith('#') ? 900 : 400;
      return `<div style="font-weight:${weight};font-size:16px;line-height:24px;color:#ffffff;${i > 0 && weight === 900 ? 'padding-top:12px;' : ''}">${l}</div>`;
    })
    .join('\n');
  return `<tr><td class="pad" style="background:${EMAIL_COLOURS.teal};padding:28px 40px;font-family:${FONT};">
${rows}
</td></tr>`;
}

function logoRow(o: LayoutOptions): string {
  if (o.logoUrl) {
    return `<tr><td align="center" style="padding:0 0 24px 0;"><img src="${o.logoUrl}" alt="${o.venueName}" height="96" style="display:block;height:96px;width:auto;max-width:420px;border:0;"></td></tr>`;
  }
  if (!o.showLogoPlaceholder) return '';
  return `<tr><td align="center" style="padding:0 0 24px 0;"><div style="display:inline-block;border:2px dashed #ffffff;border-radius:8px;padding:18px 32px;font-family:${FONT};font-weight:700;font-size:14px;line-height:20px;color:#ffffff;">Logo goes here (Admin → Settings → Email logo URL)</div></td></tr>`;
}

/** Build the whole email: purple background, logo, white card holding the sections, teal footer. */
export function emailLayout(s: EmailSections, o: LayoutOptions): string {
  const card = [
    s.badge ? badge(s.badge) : '',
    title(s.title),
    ...s.body.map((b) => (b.kind === 'button' ? button(b.label, b.url) : para(b.html))),
    ...s.detailCards.map(detailCard),
    thanks(s.thanks),
  ]
    .filter(Boolean)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${o.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; background:${EMAIL_COLOURS.purple}; }
  table { border-collapse:collapse; }
  img { border:0; }
  @media only screen and (max-width:620px) {
    .card { width:100% !important; }
    .pad { padding-left:24px !important; padding-right:24px !important; }
    .headline { font-size:30px !important; line-height:34px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${EMAIL_COLOURS.purple};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${EMAIL_COLOURS.purple};font-size:1px;line-height:1px;">${o.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLOURS.purple};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;">
${logoRow(o)}
<tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td class="pad" style="padding:40px 40px 32px 40px;font-family:${FONT};font-size:17px;line-height:26px;color:#000000;">
${card}
</td></tr>
${footer(s.footer)}
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
