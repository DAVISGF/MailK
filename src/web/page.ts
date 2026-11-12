export const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MailK</title>
<style>
  :root { --bg:#f6f7f9; --fg:#1d2330; --mut:#6b7385; --card:#fff; --line:#e2e5ec; --acc:#2f6fed; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14171e; --fg:#e6e9f0; --mut:#8f98ab; --card:#1c202a; --line:#2b3140; --acc:#6b9bff; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; gap:12px; align-items:center; padding:10px 16px; background:var(--card); border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; }
  main { display:grid; grid-template-columns: 220px 1fr; min-height: calc(100vh - 52px); }
  aside { border-right:1px solid var(--line); padding:10px; background:var(--card); overflow:auto; }
  aside h2 { font-size:12px; text-transform:uppercase; color:var(--mut); margin:12px 0 6px; }
  aside button { display:block; width:100%; text-align:left; margin:2px 0; padding:6px 8px; border:0; border-radius:6px; background:none; color:var(--fg); cursor:pointer; }
  aside button.on { background:var(--acc); color:#fff; }
  aside button.on .mut { color:inherit; opacity:.8; }
  section { padding:12px; overflow:auto; }
  input, button.btn { padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); }
  button.btn { cursor:pointer; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); }
  td, th { padding:7px 10px; border-bottom:1px solid var(--line); text-align:left; }
  tr.row { cursor:pointer; } tr.row:hover { background:var(--bg); } .unseen td { font-weight:600; }
  .mut { color:var(--mut); } .tag { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:1px 7px; margin-right:4px; font-size:12px; }
  .msg { background:var(--card); border:1px solid var(--line); padding:12px; border-radius:8px; margin-top:12px; }
  iframe { width:100%; height:360px; border:1px solid var(--line); background:#fff; }
  pre { white-space:pre-wrap; }
  form.card { display:none; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:12px; }
  form.card.open { display:block; }
  form.card h3 { margin:0 0 10px; font-size:14px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:10px; }
  .grid label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--mut); }
  .grid input { width:100%; }
  .actions { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  button.primary { background:var(--acc); color:#fff; border-color:var(--acc); }
  .ok { color:#1f9d55; } .err { color:#d64545; }
  @media (max-width:700px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <h1>MailK</h1>
  <input id="q" placeholder="Buscar…" size="24">
  <input id="token" placeholder="Token API" type="password" size="16">
  <button class="btn" id="refresh">Actualizar</button>
  <button class="btn" id="clear">Borrar vista</button>
  <button class="btn" id="toggle-new">+ Nueva cuenta</button>
  <span class="mut" id="info"></span>
</header>
<main>
  <aside>
    <h2>Grupos</h2><div id="groups"></div>
    <h2>Cuentas</h2><div id="accounts"></div>
  </aside>
  <section>
    <form id="new-account" class="card" autocomplete="off">
      <h3>Nueva cuenta de prueba</h3>
      <div class="grid">
        <label>Dirección *<input name="address" required placeholder="usuario@miproyecto.test"></label>
        <label>Grupo (proyecto)<input name="group" list="group-list" placeholder="default"></label>
        <label>Clave IMAP/POP3<input name="password" type="password" placeholder="Por defecto: la dirección"></label>
        <label>Etiquetas<input name="tags" placeholder="registro, qa"></label>
        <label>Reenviar a (relay)<input name="relayTo" placeholder="Opcional: real@dominio.com"></label>
      </div>
      <datalist id="group-list"></datalist>
      <div class="actions">
        <button class="btn primary" type="submit">Crear cuenta</button>
        <button class="btn" type="button" id="cancel-new">Cancelar</button>
        <span id="new-result"></span>
      </div>
    </form>
    <table><thead><tr><th>Fecha</th><th>Para</th><th>De</th><th>Asunto</th><th>Tags</th></tr></thead><tbody id="rows"></tbody></table>
    <div id="detail"></div>
  </section>
</main>
<script>
const $ = (s) => document.querySelector(s);
let group = '', account = '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
try { $('#token').value = localStorage.getItem('mailk-token') || ''; } catch {}
async function api(path, opts = {}) {
  const t = $('#token').value;
  try { localStorage.setItem('mailk-token', t); } catch {}
  const r = await fetch(path, { ...opts, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}) } });
  if (r.status === 401) { $('#info').textContent = 'Token inválido'; throw new Error('401'); }
  return r.json();
}
async function load() {
  const [groups, accounts] = await Promise.all([api('/api/groups'), api('/api/accounts' + (group ? '?group=' + encodeURIComponent(group) : ''))]);
  $('#groups').innerHTML = '<button data-g="" class="' + (group ? '' : 'on') + '">Todos</button>' +
    groups.map((g) => '<button data-g="' + esc(g.name) + '" class="' + (g.name === group ? 'on' : '') + '">' + esc(g.name) + ' <span class="mut">(' + g.messages + ')</span></button>').join('');
  $('#group-list').innerHTML = groups.map((g) => '<option value="' + esc(g.name) + '">').join('');
  $('#accounts').innerHTML = '<button data-a="" class="' + (account ? '' : 'on') + '">Todas</button>' +
    accounts.map((a) => '<button data-a="' + esc(a.address) + '" class="' + (a.address === account ? 'on' : '') + '">' + esc(a.address) + '</button>').join('');
  const p = new URLSearchParams();
  if (group) p.set('group', group); if (account) p.set('account', account); if ($('#q').value) p.set('q', $('#q').value);
  const msgs = await api('/api/messages?' + p);
  $('#info').textContent = msgs.length + ' correo(s)';
  $('#rows').innerHTML = msgs.map((m) => '<tr class="row ' + (m.seen ? '' : 'unseen') + '" data-id="' + m.id + '"><td class="mut">' + esc(m.receivedAt.replace('T', ' ').slice(0, 19)) + '</td><td>' + esc(m.to) + '</td><td>' + esc(m.from) + '</td><td>' + esc(m.subject) + '</td><td>' + m.tags.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</td></tr>').join('');
}
async function show(id) {
  const m = await api('/api/messages/' + id);
  const body = m.html ? '<iframe sandbox srcdoc="' + esc(m.html) + '"></iframe>' : '<pre>' + esc(m.text) + '</pre>';
  const att = m.attachments.map((a) => '<a href="/api/messages/' + id + '/attachments/' + a.index + '">' + esc(a.filename) + '</a>').join(' · ');
  $('#detail').innerHTML = '<div class="msg"><b>' + esc(m.subject) + '</b><div class="mut">De: ' + esc(m.from) + ' · Para: ' + esc(m.to) + '</div>' + body + (att ? '<div>Adjuntos: ' + att + '</div>' : '') + '<p><a href="/api/messages/' + id + '/raw">Ver raw</a></p></div>';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-g],button[data-a]'); const r = e.target.closest('tr.row');
  if (b) { if (b.dataset.g !== undefined) { group = b.dataset.g; account = ''; } else account = b.dataset.a; load(); }
  else if (r) show(r.dataset.id);
});
$('#refresh').onclick = load; $('#q').onchange = load;
$('#clear').onclick = async () => {
  if (!confirm('¿Borrar los correos de la vista actual?')) return;
  const t = $('#token').value;
  const url = account ? '/api/accounts/' + encodeURIComponent(account) + '/messages' : group ? '/api/groups/' + encodeURIComponent(group) + '/messages' : null;
  if (!url) { alert('Selecciona un grupo o una cuenta'); return; }
  await fetch(url, { method: 'DELETE', headers: t ? { Authorization: 'Bearer ' + t } : {} });
  load();
};
const form = $('#new-account');
const result = (text, cls) => { $('#new-result').textContent = text; $('#new-result').className = cls || ''; };
$('#toggle-new').onclick = () => {
  form.classList.toggle('open');
  if (form.classList.contains('open')) { if (group && !form.group.value) form.group.value = group; form.address.focus(); }
};
$('#cancel-new').onclick = () => { form.reset(); result(''); form.classList.remove('open'); };
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = { address: form.address.value.trim() };
  if (form.group.value.trim()) body.group = form.group.value.trim();
  if (form.password.value) body.password = form.password.value;
  const tags = form.tags.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (tags.length) body.tags = tags;
  if (form.relayTo.value.trim()) body.relayTo = form.relayTo.value.trim();
  const t = $('#token').value;
  result('Creando…');
  try {
    const r = await fetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 201) {
      result('Cuenta creada: ' + data.address + ' (grupo ' + data.group + ')', 'ok');
      form.reset();
      group = data.group; account = data.address;
      await load();
    } else if (r.status === 401) result('Token inválido: pega el token de la API arriba.', 'err');
    else if (r.status === 409) result('Esa cuenta ya existe.', 'err');
    else if (r.status === 400) result('Datos inválidos: revisa la dirección (usuario@dominio), el grupo (letras, números, . _ -) y el correo de reenvío.', 'err');
    else result('Error ' + r.status + ': ' + (data.error || 'no se pudo crear'), 'err');
  } catch { result('No se pudo conectar con MailK.', 'err'); }
};
load().catch(() => {});
</script>
</body>
</html>`;
