// Joga Web: recebe imagens do app Joga, pela internet, criptografadas.
//
// A página gera uma chave e um canal aleatórios e mostra no QR. O Joga lê o
// QR, criptografa a imagem com essa chave (AES-256-GCM) e manda pelo ntfy.sh
// para esse canal. O ntfy.sh só vê dados embaralhados: a chave fica só no QR,
// entre o celular e esta aba.
'use strict';

(async () => {
  const STORE = 'joga-web';
  const AAD = new TextEncoder().encode('joga-web1');
  const $ = (id) => document.getElementById(id);

  const b64url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64url = (text) => {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
  };
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));

  const read = (storage) => {
    try {
      const s = JSON.parse(storage.getItem(STORE) || 'null');
      return s && /^joga[0-9a-f]{32}$/.test(s.topic) && fromB64url(s.key).length === 32 ? s : null;
    } catch (_) {
      return null;
    }
  };
  const write = (storage, value) => {
    try {
      if (value) storage.setItem(STORE, JSON.stringify(value));
      else storage.removeItem(STORE);
    } catch (_) { /* navegador sem armazenamento: só nesta aba */ }
  };

  const remembered = read(localStorage);
  const session = remembered || read(sessionStorage) || { topic: 'joga' + hex(random(16)), key: b64url(random(32)) };
  write(sessionStorage, session);
  $('remember').checked = !!remembered;
  $('remember').addEventListener('change', (e) => write(localStorage, e.target.checked ? session : null));

  // QR com o canal e a chave.
  const qr = qrcode(0, 'M');
  qr.addData(`joga-web1:${session.topic}.${session.key}`);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });

  const key = await crypto.subtle.importKey('raw', fromB64url(session.key), 'AES-GCM', false, ['decrypt']);

  const status = (text, ok) => {
    $('status').textContent = text;
    $('status').className = ok ? 'ok' : 'muted';
  };

  let current = null; // { jpeg: Blob, url: string }
  let pendingCopy = false;

  async function copy() {
    if (!current) return;
    try {
      const bitmap = await createImageBitmap(current.jpeg);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      pendingCopy = false;
      $('copy').classList.add('hidden');
      status('Imagem copiada. É só dar Ctrl+V.', true);
      document.title = 'Joga · copiada';
    } catch (_) {
      // Sem foco na página (ou o navegador não deixa): copia ao voltar
      // para a aba, ou no botão.
      pendingCopy = true;
      $('copy').classList.remove('hidden');
      status('Imagem chegou. Clique na página para copiar.', false);
      document.title = 'Joga · imagem nova';
    }
  }

  async function receive(url) {
    try {
      const response = await fetch(url, { referrerPolicy: 'no-referrer' });
      const box = new Uint8Array(await response.arrayBuffer());
      if (box.length < 1 + 12 + 16 || box[0] !== 1) return;
      const clear = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: box.slice(1, 13), additionalData: AAD },
        key,
        box.slice(13),
      );
      if (current) URL.revokeObjectURL(current.url);
      const jpeg = new Blob([clear], { type: 'image/jpeg' });
      current = { jpeg, url: URL.createObjectURL(jpeg) };
      $('img').src = current.url;
      const now = new Date();
      const two = (n) => String(n).padStart(2, '0');
      $('save').href = current.url;
      $('save').download = `imagem-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
        `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.jpg`;
      $('shot').classList.remove('hidden');
      $('pair').classList.add('hidden');
      $('showqr').classList.remove('hidden');
      await copy();
    } catch (_) {
      // Não abriu com a chave desta aba (outro QR, ou lixo): ignora.
    }
  }

  const events = new EventSource(`https://ntfy.sh/${session.topic}/sse`);
  events.onopen = () => { if (!current) status('Esperando imagem...', false); };
  events.onerror = () => status('Sem conexão. Tentando de novo...', false);
  events.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const url = msg.attachment && msg.attachment.url;
      if (msg.event === 'message' && typeof url === 'string' && url.startsWith('https://ntfy.sh/file/')) {
        receive(url);
      }
    } catch (_) { /* mensagem estranha: ignora */ }
  };

  window.addEventListener('focus', () => { if (pendingCopy) copy(); });
  document.addEventListener('click', () => { if (pendingCopy) copy(); });
  $('img').addEventListener('click', copy);
  $('copy').addEventListener('click', copy);
  $('showqr').addEventListener('click', () => {
    $('pair').classList.toggle('hidden');
  });
  $('reset').addEventListener('click', () => {
    write(sessionStorage, null);
    write(localStorage, null);
    location.reload();
  });
})();
