// Shared server-rendered shell for the admin panel. Mobile-first: single
// column, large tap targets, sticky nav; widens on larger screens.

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function money(cents: number): string {
  return '€' + (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}

const STYLE = `
  :root{--bg:#F2EEE6;--card:#FFFDF8;--ink:#16201C;--muted:#6C7A70;--line:#DCD5C7;--accent:#B4562F;--green:#4E7A5E}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  a{color:var(--accent);text-decoration:none}
  header.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
  header.top .brand{font-weight:600}
  nav.tabs{display:flex;gap:6px;flex-wrap:wrap}
  nav.tabs a{padding:8px 12px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--ink);background:var(--card)}
  nav.tabs a.active{background:var(--ink);color:var(--bg)}
  main{max-width:1100px;margin:0 auto;padding:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px;margin-bottom:14px}
  h1{font-size:20px;margin:0 0 12px} h2{font-size:16px;margin:0 0 10px}
  .muted{color:var(--muted);font-size:13px}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .pill.pending{background:#F7E9DE;color:#9B4A22}
  .pill.confirmed{background:#EDF1E9;color:#3B6349}
  .pill.cancelled,.pill.no_show{background:#EEE9E0;color:#8A9188}
  .pill.completed{background:#E4E9F0;color:#3E5170}
  .grid{display:grid;gap:10px}
  .row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #EFEAE0}
  form.inline{display:inline}
  input,select,textarea{font:inherit;width:100%;padding:11px;border:1px solid #C9C2B2;border-radius:4px;background:#fff}
  label{display:block;font-size:13px;color:var(--muted);margin:8px 0 4px}
  button,.btn{font:inherit;border:none;border-radius:999px;padding:11px 16px;cursor:pointer;font-size:14px}
  .btn.primary,button.primary{background:var(--accent);color:#FFF8F0}
  .btn.dark,button.dark{background:var(--ink);color:var(--bg)}
  .btn.ghost,button.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
  .btn.small,button.small{padding:7px 12px;font-size:13px}
  .day{border:1px solid var(--line);border-radius:6px;background:var(--card);overflow:hidden}
  .day h3{margin:0;padding:8px 12px;font-size:14px;background:#F7F4EE;border-bottom:1px solid var(--line)}
  .appt{padding:10px 12px;border-bottom:1px solid #EFEAE0;display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
  .appt:last-child{border-bottom:none}
  .cols{display:grid;grid-template-columns:1fr;gap:12px}
  @media(min-width:760px){.cols.week{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}}
  .flash{padding:10px 12px;border-radius:6px;margin-bottom:12px}
  .flash.ok{background:#EDF1E9;border:1px solid var(--green)}
  .flash.err{background:#F7E4DE;border:1px solid var(--accent)}
  table{width:100%;border-collapse:collapse} td,th{text-align:left;padding:6px 4px;font-size:14px;border-bottom:1px solid #EFEAE0}
`;

const TABS: [string, string][] = [
  ['/admin', 'Week'],
  ['/admin/upcoming', 'Upcoming'],
  ['/admin/new', 'Add booking'],
  ['/admin/blackouts', 'Blackouts'],
  ['/admin/templates', 'Hours'],
  ['/admin/services', 'Services'],
  ['/admin/settings', 'Settings'],
  ['/admin/patient', 'Patient / GDPR'],
];

export function layout(active: string, title: string, body: string, flash?: { ok?: string; err?: string }): string {
  const tabs = TABS.map(
    ([href, label]) =>
      `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`,
  ).join('');
  const flashHtml = flash?.ok
    ? `<div class="flash ok">${esc(flash.ok)}</div>`
    : flash?.err
    ? `<div class="flash err">${esc(flash.err)}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)} · Virthy admin</title><style>${STYLE}</style></head>
    <body>
    <header class="top">
      <span class="brand">Virthy Jain · admin</span>
      <nav class="tabs">${tabs}<form class="inline" method="POST" action="/admin/logout"><button class="ghost small" type="submit">Sign out</button></form></nav>
    </header>
    <main>${flashHtml}${body}</main></body></html>`;
}
