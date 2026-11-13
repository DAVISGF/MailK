// MailK · interfaz web (JavaScript sin dependencias).
// Flujo: acceso con token → proyectos (barra lateral) → cuentas y correos del proyecto.
'use strict';
(() => {
  // ---------------------------------------------------------------- utilidades
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NAME_RE = /^[\w.-]{1,64}$/;
  const ADDR_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const SAFE_TLD = /\.(test|example|invalid|localhost)$/i;
  const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0z"/><path d="M12 17v5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>'
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }
  };
  const fmtDate = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  };
  const randomPassword = () => {
    const words = ['sol', 'rio', 'mar', 'pino', 'luna', 'nube', 'roca', 'faro', 'lago', 'puma', 'cielo', 'trigo'];
    const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
    return `${words[rnd(words.length)]}-${words[rnd(words.length)]}-${1000 + rnd(9000)}`;
  };
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'pruebas';

  // ---------------------------------------------------------------- estado
  const state = {
    token: store.get('mailk-token') || '',
    authed: false,
    config: null,
    groups: [],
    group: store.get('mailk-group') || '',
    tab: 'cuentas',
    accounts: [],
    messages: [],
    accountFilter: '',
    search: '',
    message: null, // detalle del correo abierto
    revealed: new Set(),
    addingProject: false
  };

  // ---------------------------------------------------------------- API
  class ApiError extends Error {}
  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (state.token) headers.authorization = 'Bearer ' + state.token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError('No hay conexión con MailK. Revisa tu internet e inténtalo de nuevo.');
    }
    if (res.status === 401) {
      // Solo se vuelve a la pantalla de acceso si la sesión estaba abierta; si no, el formulario muestra el error.
      if (state.authed) { state.authed = false; render(); }
      throw new ApiError('El token no es válido. Revisa que sea el MAILK_API_TOKEN de tu servidor.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`);
    return data;
  }

  // ---------------------------------------------------------------- avisos
  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3000);
  }
  async function copy(text, label = 'Copiado') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.append(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast(`${label}: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`, 'ok');
  }

  // ---------------------------------------------------------------- carga de datos
  async function loadAll() {
    const [config, groups] = await Promise.all([api('/api/config'), api('/api/groups')]);
    state.config = config;
    state.groups = groups;
    state.authed = true;
    if (state.group && !groups.some((g) => g.name === state.group)) state.group = '';
    if (!state.group && groups.length) state.group = groups[0].name;
    await loadGroupData();
  }
  async function loadGroupData() {
    if (!state.group) { state.accounts = []; state.messages = []; return; }
    const g = encodeURIComponent(state.group);
    const p = new URLSearchParams({ group: state.group });
    if (state.accountFilter) p.set('account', state.accountFilter);
    if (state.search) p.set('q', state.search);
    const [accounts, messages] = await Promise.all([api('/api/accounts?group=' + g), api('/api/messages?' + p)]);
    state.accounts = accounts;
    state.messages = messages;
  }
  let lastSignature = '';
  async function refresh({ quiet = false } = {}) {
    try {
      state.groups = await api('/api/groups');
      await loadGroupData();
      // En la actualización automática solo se redibuja si algo cambió (no recarga el correo abierto).
      // El correo abierto es parte de la firma: abrir otro correo (aunque ya esté leído) siempre redibuja.
      const sig = JSON.stringify([state.groups, state.accounts, state.messages, state.message?.id ?? null]);
      if (quiet && sig === lastSignature) return;
      lastSignature = sig;
      renderSidebar(); renderMain();
    } catch (e) { if (!quiet) toast(e.message, 'err'); }
  }

  // ---------------------------------------------------------------- vistas
  function render() {
    const app = $('#app');
    if (!state.authed) { app.innerHTML = loginView(); $('#token-input')?.focus(); return; }
    app.innerHTML = `
      <div class="shell">
        <header class="topbar">
          <div class="brand"><img src="/favicon.svg" alt=""><span>MailK</span><span class="muted hide-sm" style="font-weight:500;font-size:13px">Correos de prueba</span></div>
          <div class="spacer"></div>
          <button class="btn btn-ghost" data-action="connect">${ICON.plug}<span class="hide-sm">Conectar tu app</span></button>
          <button class="btn btn-ghost icon-btn" data-action="refresh" aria-label="Actualizar">${ICON.refresh}</button>
          ${state.config?.auth ? '<button class="btn btn-ghost" data-action="logout">Salir</button>' : ''}
        </header>
        <div class="layout">
          <nav class="sidebar" id="sidebar" aria-label="Proyectos"></nav>
          <main class="main" id="main"></main>
        </div>
      </div>`;
    renderSidebar(); renderMain();
  }

  function loginView() {
    return `
      <div class="login">
        <form class="login-card" data-form="login">
          <div class="brand"><img src="/favicon.svg" alt=""><span>MailK</span></div>
          <div><h1>Ingresa a tus correos de prueba</h1><p>Pega el token de acceso (<code>MAILK_API_TOKEN</code>) de tu servidor MailK.</p></div>
          <div class="field">
            <label for="token-input">Token de acceso</label>
            <input class="input" id="token-input" name="token" type="password" autocomplete="current-password" required value="${esc(state.token)}">
            <span class="hint" id="login-err" role="alert"></span>
          </div>
          <button class="btn btn-primary" type="submit">Entrar</button>
        </form>
      </div>`;
  }

  function renderSidebar() {
    const el = $('#sidebar');
    if (!el) return;
    const items = state.groups.map((g) => `
      <button class="proj" data-action="select-group" data-group="${esc(g.name)}" aria-current="${g.name === state.group}">
        <span class="name">${esc(g.name)}</span>
        ${g.unseen ? `<span class="badge" title="${g.unseen} sin leer">${g.unseen}</span>` : `<span class="meta">${g.accounts}</span>`}
      </button>`).join('');
    el.innerHTML = `
      <div class="sidebar-head"><h2>Proyectos</h2>
        <button class="btn btn-ghost btn-sm" data-action="add-project" aria-label="Nuevo proyecto">${ICON.plus}Nuevo</button></div>
      ${state.addingProject ? projectForm() : ''}
      ${items || (state.addingProject ? '' : '<p class="hint" style="padding:0 6px">Aún no tienes proyectos.</p>')}`;
    if (state.addingProject) $('#project-name')?.focus();
  }

  function projectForm() {
    return `
      <form class="inline-form" data-form="project">
        <label class="sr-only" for="project-name">Nombre del proyecto</label>
        <input class="input" id="project-name" name="name" placeholder="Ej.: kilora" maxlength="64" autocomplete="off" required>
        <span class="hint" id="project-hint">Letras, números, punto, guion o guion bajo.</span>
        <div class="row"><button class="btn btn-primary btn-sm" type="submit">Crear</button><button class="btn btn-ghost btn-sm" type="button" data-action="cancel-project">Cancelar</button></div>
      </form>`;
  }

  function renderMain() {
    const el = $('#main');
    if (!el) return;
    const mobileSelect = state.groups.length ? `
      <div class="mobile-proj">
        <label class="sr-only" for="mobile-group">Proyecto</label>
        <select class="input" id="mobile-group" data-change="select-group">${state.groups.map((g) => `<option value="${esc(g.name)}" ${g.name === state.group ? 'selected' : ''}>${esc(g.name)}${g.unseen ? ` (${g.unseen} sin leer)` : ''}</option>`).join('')}</select>
        <button class="btn" data-action="add-project-mobile">${ICON.plus}Proyecto</button>
      </div>` : '';
    if (!state.group) { el.innerHTML = mobileSelect + welcomeView(); return; }
    const g = state.groups.find((x) => x.name === state.group) || { accounts: 0, messages: 0, unseen: 0 };
    el.innerHTML = `${mobileSelect}
      <div class="page-head">
        <div><h1>${esc(state.group)}</h1>
          <div class="sub">${g.accounts} ${g.accounts === 1 ? 'cuenta' : 'cuentas'} · ${g.messages} ${g.messages === 1 ? 'correo' : 'correos'}${g.unseen ? ` · <b>${g.unseen} sin leer</b>` : ''}</div></div>
        <div class="actions">
          <button class="btn btn-primary" data-action="new-account">${ICON.plus}Nueva cuenta</button>
          <button class="btn btn-ghost" data-action="empty-group" ${g.messages ? '' : 'disabled title="No hay correos para vaciar"'}>Vaciar correos</button>
          <button class="btn btn-danger-ghost" data-action="delete-group">Eliminar proyecto</button>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" aria-selected="${state.tab === 'cuentas'}" data-action="tab" data-tab="cuentas">Cuentas<span class="count">${state.accounts.length}</span></button>
        <button class="tab" role="tab" aria-selected="${state.tab === 'correos'}" data-action="tab" data-tab="correos">Correos<span class="count">${g.messages}</span></button>
      </div>
      <div id="tab-panel">${state.tab === 'cuentas' ? accountsView() : inboxView()}</div>`;
  }

  function welcomeView() {
    return `
      <div class="empty">
        <h2>Bienvenido a MailK</h2>
        <p>Aquí recibes los correos que envían tus apps en pruebas (invitaciones, avisos, recuperación de clave) sin que lleguen a nadie real.</p>
      </div>
      <div class="steps">
        <div class="step"><b>1</b><div class="label">Crea un proyecto</div><p>Uno por app, por ejemplo «kilora». Agrupa sus cuentas y correos.</p></div>
        <div class="step"><b>2</b><div class="label">Conecta tu app</div><p>Configura su SMTP con los datos de «Conectar tu app».</p></div>
        <div class="step"><b>3</b><div class="label">Invita a una cuenta</div><p>Usa direcciones <code>.test</code>. Si no existen, MailK las crea al llegar el primer correo.</p></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" data-action="add-project-mobile">${ICON.plus}Crear mi primer proyecto</button>
        <button class="btn" data-action="connect">${ICON.plug}Conectar tu app</button>
      </div>`;
  }

  function accountsView() {
    if (!state.accounts.length) {
      return `<div class="card empty">
        <h3>Este proyecto aún no tiene cuentas</h3>
        <p>Crea una para invitarla desde tu app, o simplemente invita a cualquier dirección <code>@${esc(slug(state.group))}.test</code>: MailK crea el buzón al recibir el primer correo.</p>
        <button class="btn btn-primary" data-action="new-account">${ICON.plus}Nueva cuenta</button>
      </div>`;
    }
    const rows = state.accounts.map((a) => {
      const shown = state.revealed.has(a.address);
      return `<tr>
        <td data-label="Dirección"><div class="addr">${esc(a.address)}<button class="btn btn-ghost icon-btn" data-action="copy" data-value="${esc(a.address)}" data-label="Dirección copiada" aria-label="Copiar dirección ${esc(a.address)}">${ICON.copy}</button></div></td>
        <td data-label="Clave IMAP/POP3"><span class="secret">${shown ? esc(a.password) : '••••••••'}
          <button class="btn btn-ghost icon-btn" data-action="reveal" data-address="${esc(a.address)}" aria-label="${shown ? 'Ocultar' : 'Mostrar'} clave">${ICON.eye}</button>
          <button class="btn btn-ghost icon-btn" data-action="copy" data-value="${esc(a.password)}" data-label="Clave copiada" aria-label="Copiar clave">${ICON.copy}</button></span></td>
        <td data-label="Etiquetas"><div class="chips">${a.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('') || '<span class="muted">—</span>'}</div></td>
        <td data-label="Correos" class="count-cell">${a.messages}${a.unseen ? ` <span class="badge" title="sin leer">${a.unseen}</span>` : ''}${a.relayTo ? `<div class="hint">Reenvía a ${esc(a.relayTo)}</div>` : ''}</td>
        <td><div class="row-actions">
          <button class="btn btn-ghost btn-sm" data-action="view-account" data-address="${esc(a.address)}">Ver correos</button>
          <button class="btn btn-ghost btn-sm" data-action="edit-account" data-address="${esc(a.address)}">Editar</button>
          <button class="btn btn-ghost btn-sm" data-action="empty-account" data-address="${esc(a.address)}" ${a.messages ? '' : 'disabled'}>Vaciar</button>
          <button class="btn btn-danger-ghost btn-sm" data-action="delete-account" data-address="${esc(a.address)}">Eliminar</button>
        </div></td></tr>`;
    }).join('');
    return `<div class="card"><table class="table">
      <thead><tr><th>Dirección</th><th>Clave IMAP/POP3</th><th>Etiquetas</th><th>Correos</th><th><span class="sr-only">Acciones</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function inboxView() {
    const opts = state.accounts.map((a) => `<option value="${esc(a.address)}" ${a.address === state.accountFilter ? 'selected' : ''}>${esc(a.address)}</option>`).join('');
    const list = state.messages.map((m) => `
      <button class="mitem ${m.seen ? '' : 'unseen'}" data-action="open-message" data-id="${m.id}" aria-current="${state.message?.id === m.id}">
        <span class="top"><span class="who">${m.seen ? '' : '<span class="dot" aria-label="sin leer"></span>'}${esc(m.to)}</span><span>${esc(fmtDate(m.receivedAt))}</span></span>
        <span class="subj">${esc(m.subject || '(sin asunto)')}</span>
        <span class="hint">De: ${esc(m.from || 'desconocido')}</span>
      </button>`).join('');
    return `
      <div class="inbox-tools">
        <label class="sr-only" for="account-filter">Filtrar por cuenta</label>
        <select class="input" id="account-filter" data-change="filter-account"><option value="">Todas las cuentas</option>${opts}</select>
        <label class="sr-only" for="search">Buscar</label>
        <input class="input" id="search" type="search" placeholder="Buscar asunto, remitente o texto…" value="${esc(state.search)}" data-change="search">
      </div>
      <div class="inbox ${state.message ? 'reading' : ''}">
        <div class="card mlist-wrap"><div class="mlist">${list || `<div class="empty"><h3>Sin correos todavía</h3><p>Cuando tu app envíe un correo a ${state.accountFilter ? esc(state.accountFilter) : 'una cuenta de este proyecto'}, aparecerá aquí (se actualiza solo cada 10 segundos).</p></div>`}</div></div>
        <div class="card reader-wrap">${readerView()}</div>
      </div>`;
  }

  function extractLinks(m) {
    const found = new Set();
    if (m.html) {
      const doc = new DOMParser().parseFromString(m.html, 'text/html');
      doc.querySelectorAll('a[href]').forEach((a) => { const h = a.getAttribute('href'); if (/^https?:\/\//i.test(h)) found.add(h); });
    }
    (m.text || '').match(/https?:\/\/[^\s<>"')]+/g)?.forEach((u) => found.add(u));
    return [...found].slice(0, 8);
  }

  function readerView() {
    const m = state.message;
    if (!m) return '<div class="empty"><h3>Elige un correo</h3><p>Su contenido y sus enlaces aparecerán aquí.</p></div>';
    const links = extractLinks(m);
    const body = m.html ? `<iframe sandbox title="Contenido del correo" srcdoc="${esc(m.html)}"></iframe>` : `<pre>${esc(m.text || '(sin contenido)')}</pre>`;
    const att = m.attachments?.length ? `<div class="hint">Adjuntos: ${m.attachments.map((a) => `<a href="/api/messages/${m.id}/attachments/${a.index}" target="_blank" rel="noopener">${esc(a.filename)}</a>`).join(' · ')}</div>` : '';
    return `<div class="reader">
      <button class="btn btn-ghost btn-sm back-btn" data-action="close-message">${ICON.back}Volver</button>
      <h2>${esc(m.subject || '(sin asunto)')}</h2>
      <div class="hdrs"><span><b>De:</b> ${esc(m.from)}</span><span><b>Para:</b> ${esc(m.to)}</span><span><b>Recibido:</b> ${esc(new Date(m.receivedAt).toLocaleString('es'))}</span></div>
      <div class="toolbar">
        <button class="btn btn-sm" data-action="mark-unseen" data-id="${m.id}">Marcar como no leído</button>
        <a class="btn btn-sm" href="/api/messages/${m.id}/raw" target="_blank" rel="noopener">Ver original</a>
        <button class="btn btn-danger-ghost btn-sm" data-action="delete-message" data-id="${m.id}">Eliminar</button>
      </div>
      ${links.length ? `<div class="links"><div class="label">${ICON.link} Enlaces del correo</div>${links.map((u) => `
        <div class="lrow"><span class="lurl" title="${esc(u)}">${esc(u)}</span>
          <a class="btn btn-sm btn-primary" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Abrir</a>
          <button class="btn btn-sm" data-action="copy" data-value="${esc(u)}" data-label="Enlace copiado">${ICON.copy}Copiar</button></div>`).join('')}</div>` : ''}
      ${body}${att}
    </div>`;
  }

  // ---------------------------------------------------------------- paneles y diálogos
  function openOverlay(html, { onClose } = {}) {
    const root = $('#overlay-root');
    root.innerHTML = `<div class="overlay" data-overlay>${html}</div>`;
    const ov = root.firstElementChild;
    const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); onClose?.(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    setTimeout(() => (ov.querySelector('[autofocus]') || ov.querySelector('input,button'))?.focus(), 0);
    return { el: ov, close };
  }

  function confirmDialog({ title, body, items = [], confirm = 'Eliminar' }) {
    return new Promise((resolve) => {
      let answered = false;
      const { el, close } = openOverlay(`
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
          <h2 id="dlg-title">${esc(title)}</h2>
          <p>${body}</p>
          ${items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : ''}
          <div class="foot"><button class="btn" data-close autofocus>Cancelar</button><button class="btn btn-danger" data-ok>${esc(confirm)}</button></div>
        </div>`, { onClose: () => { if (!answered) resolve(false); } });
      el.querySelector('[data-ok]').addEventListener('click', () => { answered = true; close(); resolve(true); });
    });
  }

  function accountDrawer(existing) {
    const editing = !!existing;
    const group = existing?.group || state.group;
    const [user, domain] = existing ? existing.address.split('@') : ['', `${slug(group)}.test`];
    const relayOn = !!state.config?.relay;
    const { el, close } = openOverlay(`
      <form class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-form="account" novalidate>
        <div class="drawer-head"><h2 id="drawer-title">${editing ? 'Editar cuenta' : 'Nueva cuenta de prueba'}</h2>
          <button class="btn btn-ghost icon-btn" type="button" data-close aria-label="Cerrar">${ICON.x}</button></div>
        <div class="drawer-body">
          ${editing ? `<div class="field"><span class="label">Dirección</span><div class="preview-addr">${esc(existing.address)}</div></div>` : `
          <div class="field">
            <span class="label" id="addr-label">Dirección de correo</span>
            <div class="input-group" role="group" aria-labelledby="addr-label">
              <label class="sr-only" for="acc-user">Usuario</label>
              <input class="input" id="acc-user" name="user" placeholder="chofer1" value="${esc(user)}" autocomplete="off" autofocus>
              <span class="addon">@</span>
              <label class="sr-only" for="acc-domain">Dominio</label>
              <input class="input" id="acc-domain" name="domain" value="${esc(domain)}" autocomplete="off">
            </div>
            <div class="preview-addr" id="acc-preview" aria-live="polite"></div>
            <span class="hint" id="acc-domain-hint"></span>
          </div>`}
          <div class="field">
            <label for="acc-group">Proyecto</label>
            <select class="input" id="acc-group" name="group">${state.groups.map((g) => `<option ${g.name === group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
          </div>
          <div class="field">
            <label for="acc-pass">Clave para leer el buzón (IMAP/POP3)</label>
            <div class="input-group">
              <input class="input" id="acc-pass" name="password" value="${esc(existing?.password || randomPassword())}" autocomplete="off">
              <button class="btn" type="button" data-regen aria-label="Generar otra clave">${ICON.refresh}</button>
              <button class="btn" type="button" data-copy-pass aria-label="Copiar clave">${ICON.copy}</button>
            </div>
            <span class="hint">Solo hace falta si vas a leer este buzón con un cliente de correo. Siempre puedes verla aquí.</span>
          </div>
          <div class="field">
            <label for="acc-tag-input">Etiquetas <span class="muted" style="font-weight:400">(opcional)</span></label>
            <div class="chips" id="acc-tags"></div>
            <input class="input" id="acc-tag-input" placeholder="Escribe y presiona Enter, p. ej. chofer" autocomplete="off">
            <span class="hint">Sirven para filtrar. Los correos que recibe la cuenta heredan sus etiquetas.</span>
          </div>
          <details class="adv" ${existing?.relayTo ? 'open' : ''}>
            <summary>Opciones avanzadas</summary>
            <div class="field">
              <label for="acc-relay">Reenviar una copia a un correo real</label>
              <input class="input" id="acc-relay" name="relayTo" type="email" placeholder="tu-correo@empresa.com" value="${esc(existing?.relayTo || '')}" ${relayOn ? '' : 'disabled'}>
              <span class="hint">${relayOn ? 'Además de guardarlo en MailK, cada correo de esta cuenta se reenvía a esa dirección. Déjalo vacío para no reenviar.' : 'No disponible: el servidor no tiene configurado el reenvío (MAILK_RELAY_URL).'}</span>
            </div>
          </details>
          <span class="hint err" id="acc-err" role="alert"></span>
        </div>
        <div class="drawer-foot">
          <button class="btn" type="button" data-close>Cancelar</button>
          <button class="btn btn-primary" type="submit">${editing ? 'Guardar cambios' : 'Crear cuenta'}</button>
        </div>
      </form>`);

    const tags = [...(existing?.tags || [])];
    const tagBox = el.querySelector('#acc-tags');
    const drawTags = () => { tagBox.innerHTML = tags.map((t, i) => `<span class="chip">${esc(t)}<button type="button" data-rm-tag="${i}" aria-label="Quitar etiqueta ${esc(t)}">×</button></span>`).join(''); };
    drawTags();
    const tagInput = el.querySelector('#acc-tag-input');
    const addTag = () => { tagInput.value.split(',').map((s) => s.trim()).filter(Boolean).forEach((t) => { if (!tags.includes(t)) tags.push(t); }); tagInput.value = ''; drawTags(); };
    tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } });
    tagInput.addEventListener('blur', addTag);
    tagBox.addEventListener('click', (e) => { const b = e.target.closest('[data-rm-tag]'); if (b) { tags.splice(Number(b.dataset.rmTag), 1); drawTags(); } });

    const pass = el.querySelector('#acc-pass');
    el.querySelector('[data-regen]').addEventListener('click', () => { pass.value = randomPassword(); });
    el.querySelector('[data-copy-pass]').addEventListener('click', () => copy(pass.value, 'Clave copiada'));

    const userIn = el.querySelector('#acc-user');
    const domIn = el.querySelector('#acc-domain');
    const groupSel = el.querySelector('#acc-group');
    const address = () => editing ? existing.address : `${userIn.value.trim().toLowerCase()}@${domIn.value.trim().toLowerCase()}`;
    const updatePreview = () => {
      if (editing) return;
      const a = address();
      el.querySelector('#acc-preview').textContent = userIn.value.trim() ? a : 'La dirección aparecerá aquí';
      const hint = el.querySelector('#acc-domain-hint');
      const d = domIn.value.trim();
      if (d && !SAFE_TLD.test(d)) { hint.className = 'hint warn'; hint.textContent = '«' + d + '» podría ser un dominio real. Recomendado terminar en .test para que, si tu app usa un servicio real por error, el correo no le llegue a nadie.'; }
      else { hint.className = 'hint'; hint.textContent = 'Dominio de prueba: ningún correo real puede llegar ahí.'; }
    };
    if (!editing) {
      userIn.addEventListener('input', updatePreview);
      domIn.addEventListener('input', () => { domIn.dataset.touched = '1'; updatePreview(); });
      groupSel.addEventListener('change', () => { if (!domIn.dataset.touched) domIn.value = `${slug(groupSel.value)}.test`; updatePreview(); });
      updatePreview();
    }

    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      addTag();
      const err = el.querySelector('#acc-err');
      const a = address();
      if (!editing && !ADDR_RE.test(a)) { err.textContent = 'Escribe un usuario y un dominio válidos, por ejemplo chofer1 @ kilora.test.'; userIn.setAttribute('aria-invalid', 'true'); userIn.focus(); return; }
      if (!pass.value.trim()) { err.textContent = 'La clave no puede quedar vacía.'; pass.focus(); return; }
      const relay = el.querySelector('#acc-relay').value.trim();
      const body = { group: groupSel.value, password: pass.value.trim(), tags, relayTo: relay || null };
      const btn = el.querySelector('[type="submit"]');
      btn.disabled = true; btn.textContent = editing ? 'Guardando…' : 'Creando…';
      try {
        if (editing) await api('/api/accounts/' + encodeURIComponent(a), { method: 'PATCH', body });
        else await api('/api/accounts', { method: 'POST', body: { address: a, ...body } });
        close();
        state.group = body.group; store.set('mailk-group', state.group);
        toast(editing ? 'Cambios guardados' : `Cuenta creada: ${a}`, 'ok');
        await refresh();
      } catch (ex) {
        err.textContent = /ya existe/i.test(ex.message) ? `La cuenta ${a} ya existe. Elige otro usuario.` : ex.message;
        btn.disabled = false; btn.textContent = editing ? 'Guardar cambios' : 'Crear cuenta';
      }
    });
  }

  function connectDialog() {
    const c = state.config || {};
    const host = c.publicHost || location.hostname;
    const ports = c.ports || {};
    const user = c.auth ? (c.smtpUser || 'MAILK_SMTP_USER') : 'cualquiera';
    const pass = c.auth ? 'TU_CLAVE_SMTP' : 'cualquiera';
    const smtpUrl = `smtp://${user}:${pass}@${host}:${ports.smtp}`;
    const row = (k, v, copyable = true) => `<dt>${k}</dt><dd>${esc(v)}</dd><dd>${copyable ? `<button class="btn btn-ghost icon-btn" data-action="copy" data-value="${esc(v)}" data-label="${esc(k)} copiado" aria-label="Copiar ${esc(k)}">${ICON.copy}</button>` : ''}</dd>`;
    openOverlay(`
      <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="conn-title">
        <div class="drawer-head"><h2 id="conn-title">Conectar tu app</h2><button class="btn btn-ghost icon-btn" data-close aria-label="Cerrar">${ICON.x}</button></div>
        <div class="drawer-body">
          <p class="muted" style="margin:0">Configura el correo de tu app (solo en pruebas) para que envíe a MailK. Nada sale a internet.</p>
          <div><div class="label" style="margin-bottom:8px">Envío (SMTP)</div>
            <dl class="kv">${row('Servidor', host)}${row('Puerto', String(ports.smtp))}${row('Seguridad', 'Ninguna (sin TLS)', false)}${row('Usuario', user)}${row('Clave', c.auth ? 'MAILK_SMTP_PASS de tus credenciales' : 'cualquiera', false)}</dl></div>
          <div class="field"><span class="label">Como una sola variable (SMTP_URL)</span>
            <div class="input-group"><input class="input" readonly value="${esc(smtpUrl)}" aria-label="SMTP_URL"><button class="btn" data-action="copy" data-value="${esc(smtpUrl)}" data-label="SMTP_URL copiado">${ICON.copy}</button></div>
            ${c.auth ? '<span class="hint">Reemplaza TU_CLAVE_SMTP por la clave SMTP de tus credenciales.</span>' : ''}</div>
          <div class="notice info">Para ordenar por proyecto, tu app puede enviar la cabecera <code>X-MailK-Group: ${esc(state.group || 'tu-proyecto')}</code>. Si no, las cuentas nuevas van al proyecto «${esc(c.defaultGroup || 'default')}».</div>
          <div><div class="label" style="margin-bottom:8px">Lectura con un cliente de correo</div>
            <dl class="kv">${row('IMAP', `${host}:${ports.imap}`)}${row('POP3', `${host}:${ports.pop3}`)}${row('Usuario', 'la dirección completa', false)}${row('Clave', 'la de la cuenta (pestaña Cuentas)', false)}</dl></div>
        </div>
        <div class="drawer-foot"><button class="btn btn-primary" data-close>Listo</button></div>
      </div>`);
  }

  // ---------------------------------------------------------------- acciones
  async function selectGroup(name) {
    state.group = name; state.tab = 'cuentas'; state.accountFilter = ''; state.search = ''; state.message = null; state.addingProject = false;
    store.set('mailk-group', name);
    try { await loadGroupData(); } catch (e) { toast(e.message, 'err'); }
    renderSidebar(); renderMain();
  }

  const actions = {
    async 'select-group'(b) { await selectGroup(b.dataset.group); },
    'add-project'() { state.addingProject = true; renderSidebar(); },
    'add-project-mobile'() {
      if (getComputedStyle($('#sidebar')).display !== 'none') { state.addingProject = true; renderSidebar(); return; }
      const name = prompt('Nombre del nuevo proyecto (letras, números, punto, guion o guion bajo):');
      if (name) createProject(name.trim());
    },
    'cancel-project'() { state.addingProject = false; renderSidebar(); },
    tab(b) { state.tab = b.dataset.tab; state.message = null; renderMain(); },
    'new-account'() { accountDrawer(null); },
    'edit-account'(b) { accountDrawer(state.accounts.find((a) => a.address === b.dataset.address)); },
    connect() { connectDialog(); },
    async refresh() { await refresh(); toast('Actualizado'); },
    logout() { state.token = ''; store.set('mailk-token', null); state.authed = false; render(); },
    copy(b) { copy(b.dataset.value, b.dataset.label || 'Copiado'); },
    reveal(b) { const a = b.dataset.address; state.revealed.has(a) ? state.revealed.delete(a) : state.revealed.add(a); renderMain(); },
    async 'view-account'(b) { state.tab = 'correos'; state.accountFilter = b.dataset.address; state.message = null; await refresh(); },
    async 'open-message'(b) {
      try {
        state.message = await api('/api/messages/' + b.dataset.id);
        if (!state.message.seen) { await api('/api/messages/' + b.dataset.id, { method: 'PATCH', body: { seen: true } }); state.message.seen = true; }
        await refresh({ quiet: true });
      } catch (e) { toast(e.message, 'err'); }
    },
    'close-message'() { state.message = null; renderMain(); },
    async 'mark-unseen'(b) { await api('/api/messages/' + b.dataset.id, { method: 'PATCH', body: { seen: false } }); state.message = null; await refresh(); toast('Marcado como no leído'); },
    async 'delete-message'(b) {
      if (!(await confirmDialog({ title: '¿Eliminar este correo?', body: 'Se borra de MailK y no se puede recuperar.' }))) return;
      await api('/api/messages/' + b.dataset.id, { method: 'DELETE' }); state.message = null; await refresh(); toast('Correo eliminado', 'ok');
    },
    async 'empty-account'(b) {
      const a = state.accounts.find((x) => x.address === b.dataset.address);
      if (!(await confirmDialog({ title: `¿Vaciar ${a.address}?`, body: `Se borrarán sus <b>${a.messages}</b> correos. La cuenta se mantiene.`, confirm: 'Vaciar' }))) return;
      await api(`/api/accounts/${encodeURIComponent(a.address)}/messages`, { method: 'DELETE' }); await refresh(); toast('Buzón vaciado', 'ok');
    },
    async 'delete-account'(b) {
      const a = state.accounts.find((x) => x.address === b.dataset.address);
      if (!(await confirmDialog({ title: `¿Eliminar ${a.address}?`, body: 'Esta acción no se puede deshacer:', items: [`Se borra la cuenta y sus ${a.messages} correos.`, 'Si tu app vuelve a enviarle un correo, MailK la creará de nuevo (sin etiquetas y con otra clave).'] }))) return;
      await api('/api/accounts/' + encodeURIComponent(a.address), { method: 'DELETE' }); state.revealed.delete(a.address); await refresh(); toast('Cuenta eliminada', 'ok');
    },
    async 'empty-group'() {
      const g = state.groups.find((x) => x.name === state.group);
      if (!(await confirmDialog({ title: `¿Vaciar los correos de «${g.name}»?`, body: `Se borrarán <b>${g.messages}</b> correos de todas sus cuentas. Las cuentas se mantienen.`, confirm: 'Vaciar' }))) return;
      await api(`/api/groups/${encodeURIComponent(g.name)}/messages`, { method: 'DELETE' }); state.message = null; await refresh(); toast('Correos eliminados', 'ok');
    },
    async 'delete-group'() {
      const g = state.groups.find((x) => x.name === state.group);
      if (!(await confirmDialog({ title: `¿Eliminar el proyecto «${g.name}»?`, body: 'Esta acción no se puede deshacer:', items: [`Se borran sus <b>${g.accounts}</b> cuentas.`, `Se borran sus <b>${g.messages}</b> correos.`], confirm: 'Eliminar proyecto' }))) return;
      await api('/api/groups/' + encodeURIComponent(g.name), { method: 'DELETE' });
      state.group = ''; store.set('mailk-group', null); state.message = null;
      await loadAll(); renderSidebar(); renderMain(); toast('Proyecto eliminado', 'ok');
    }
  };

  async function createProject(name) {
    if (!NAME_RE.test(name)) { toast('Nombre inválido: usa letras, números, punto, guion o guion bajo, sin espacios.', 'err'); return false; }
    try {
      await api('/api/groups', { method: 'POST', body: { name } });
      state.addingProject = false;
      toast(`Proyecto «${name}» creado`, 'ok');
      state.groups = await api('/api/groups');
      await selectGroup(name);
      return true;
    } catch (e) {
      toast(/ya existe/i.test(e.message) ? `El proyecto «${name}» ya existe.` : e.message, 'err');
      return false;
    }
  }

  // ---------------------------------------------------------------- eventos (delegados)
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || b.disabled) return;
    const fn = actions[b.dataset.action];
    if (!fn) return;
    e.preventDefault();
    try { await fn(b); } catch (ex) { toast(ex.message, 'err'); }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-change]');
    if (!t) return;
    try {
      if (t.dataset.change === 'select-group') await selectGroup(t.value);
      if (t.dataset.change === 'filter-account') { state.accountFilter = t.value; state.message = null; await refresh(); }
      if (t.dataset.change === 'search') { state.search = t.value.trim(); state.message = null; await refresh(); }
    } catch (ex) { toast(ex.message, 'err'); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'project-name') return;
    const ok = !e.target.value || NAME_RE.test(e.target.value.trim());
    e.target.setAttribute('aria-invalid', String(!ok));
    const h = $('#project-hint');
    h.className = ok ? 'hint' : 'hint err';
    h.textContent = ok ? 'Letras, números, punto, guion o guion bajo.' : 'Sin espacios ni tildes: usa letras, números, punto, guion o guion bajo.';
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-form]');
    if (!f || f.dataset.form === 'account') return;
    e.preventDefault();
    if (f.dataset.form === 'project') { await createProject($('#project-name').value.trim()); }
    if (f.dataset.form === 'login') {
      state.token = f.token.value.trim();
      store.set('mailk-token', state.token);
      try { await loadAll(); render(); }
      catch (ex) { render(); const el = $('#login-err'); if (el) { el.className = 'hint err'; el.textContent = ex.message; } }
    }
  });

  // Actualización automática: útil mientras esperas una invitación.
  setInterval(() => {
    const typing = document.activeElement?.matches?.('input, select, textarea');
    if (state.authed && !document.hidden && !typing && !$('#overlay-root').childElementCount) refresh({ quiet: true });
  }, 10000);

  // ---------------------------------------------------------------- inicio
  (async () => {
    try { await loadAll(); } catch { /* sin token válido: se muestra la pantalla de acceso */ }
    render();
  })();
})();
