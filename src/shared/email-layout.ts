/**
 * The Scouts-branded email layout shared by every template, and the building
 * blocks the default HTML bodies are made from. Mail clients ignore most CSS,
 * so everything is tables and inline styles, in the Scouts brand palette and
 * Nunito Sans (falling back to Arial where web fonts don't load).
 *
 * Template bodies hold {{ placeholders }}; the blocks here only arrange them.
 * Values are escaped by renderEmail before they reach the layout.
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

type Colour = keyof typeof EMAIL_COLOURS;

/** The status pill above the headline. Yellow, pink and orange take black text. */
export function badge(label: string, colour: Colour): string {
  const text = colour === 'yellow' || colour === 'pink' || colour === 'orange' ? '#000000' : '#ffffff';
  return `<p style="margin:0 0 16px 0;"><span style="display:inline-block;background:${EMAIL_COLOURS[colour]};color:${text};font-family:${FONT};font-weight:700;font-size:14px;line-height:20px;padding:6px 14px;border-radius:999px;">${label}</span></p>`;
}

export function headline(text: string): string {
  return `<h1 class="headline" style="margin:0 0 24px 0;font-family:${FONT};font-weight:900;font-size:36px;line-height:40px;color:${EMAIL_COLOURS.purple};">${text}</h1>`;
}

export function para(html: string, opts: { muted?: boolean } = {}): string {
  const colour = opts.muted ? EMAIL_COLOURS.grey : '#000000';
  const size = opts.muted ? '15px;line-height:22px' : '17px;line-height:26px';
  return `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:${size};color:${colour};">${html}</p>`;
}

/** The pink panel of booking details. The first row is shown larger. */
export function details(rows: [label: string, value: string][]): string {
  const cells = rows
    .map(([label, value], i) => {
      const pad = `${i === 0 ? 24 : 12}px 28px ${i === rows.length - 1 ? 24 : 0}px 28px`;
      const size = i === 0 ? 'font-weight:900;font-size:24px;line-height:30px' : 'font-weight:700;font-size:18px;line-height:26px';
      return `<tr><td style="padding:${pad};font-family:${FONT};">
<div style="font-weight:700;font-size:13px;line-height:18px;color:#333333;">${label}</div>
<div style="${size};color:#000000;">${value}</div>
</td></tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLOURS.pink};border-radius:12px;margin:8px 0 24px 0;">
${cells}
</table>`;
}

/** A call-to-action button, with the link written out underneath for clients that block buttons. */
export function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px 0;"><tr>
<td style="background:${EMAIL_COLOURS.purple};border-radius:999px;"><a href="${url}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-weight:800;font-size:17px;line-height:22px;color:#ffffff;text-decoration:none;">${label}</a></td>
</tr></table>
${para(`Or copy this link into your browser:<br><a href="${url}" style="color:${EMAIL_COLOURS.purple};word-break:break-all;">${url}</a>`, { muted: true })}`;
}

export function signOff(): string {
  return `<p style="margin:8px 0 0 0;font-family:${FONT};font-size:17px;line-height:26px;color:#000000;">Thank you,<br><strong>{{ venue_name }}</strong></p>`;
}

export interface LayoutOptions {
  /** Already escaped. */
  title: string;
  /** Inbox preview line; already escaped. */
  preheader: string;
  /** Logo image URL from Settings; already escaped. Blank means no logo yet. */
  logoUrl: string;
  /** Already escaped. Blank hides the contact line. */
  contactEmail: string;
  venueName: string;
  /** Previews and test emails show where the logo will go while none is set. */
  showLogoPlaceholder?: boolean;
}

function logoRow(o: LayoutOptions): string {
  if (o.logoUrl) {
    return `<tr><td align="center" style="padding:0 0 24px 0;"><img src="${o.logoUrl}" alt="${o.venueName}" height="64" style="display:block;height:64px;width:auto;max-width:280px;border:0;"></td></tr>`;
  }
  if (!o.showLogoPlaceholder) return '';
  return `<tr><td align="center" style="padding:0 0 24px 0;"><div style="display:inline-block;border:2px dashed #ffffff;border-radius:8px;padding:18px 32px;font-family:${FONT};font-weight:700;font-size:14px;line-height:20px;color:#ffffff;">Logo goes here (Admin → Settings → Email logo URL)</div></td></tr>`;
}

/** Wrap a template's HTML body in the branded page: purple background, white card, teal footer. */
export function emailLayout(inner: string, o: LayoutOptions): string {
  const contact = o.contactEmail
    ? `<div style="font-weight:400;font-size:15px;line-height:22px;color:#ffffff;">Questions? Get in touch on</div>
<div style="font-weight:700;font-size:20px;line-height:30px;"><a href="mailto:${o.contactEmail}" style="color:#ffffff;text-decoration:underline;">${o.contactEmail}</a></div>`
    : '';
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
${inner}
</td></tr>
<tr><td class="pad" style="background:${EMAIL_COLOURS.teal};padding:28px 40px;font-family:${FONT};">
${contact}
<div style="font-weight:900;font-size:15px;line-height:22px;color:#ffffff;${contact ? 'padding-top:16px;' : ''}">#PlaceToBelong</div>
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
