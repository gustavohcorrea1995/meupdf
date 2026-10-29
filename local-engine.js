/*
 * PDFTools 3 — motor local + ponte para o servidor
 *
 * Este site é publicado como Static Site (não dorme). As ferramentas que
 * dão para fazer no navegador rodam aqui mesmo, sem enviar nada:
 *   juntar, dividir, organizar páginas, imagens → PDF, PDF → imagens e as
 *   miniaturas usadas por essas telas.
 *
 * As ferramentas que dependem de programas de servidor (LibreOffice,
 * Ghostscript, Tesseract/Google Vision, PDFBox) continuam no serviço
 * PDFTOOLS2 já existente. Para elas, qualquer chamada a "/api/..." é
 * redirecionada para API_BASE, e antes de enviar o arquivo o servidor é
 * "acordado" (no plano gratuito ele dorme após ~15 min sem uso).
 *
 * O resto do frontend continua chamando fetch('/api/...') como antes: este
 * arquivo intercepta essas chamadas e devolve um Response compatível.
 */
(() => {
  const API_BASE = 'https://pdftools2.onrender.com';
  const onEditorPage = /native-editor\.html/i.test(location.pathname);
  const nativeFetch = window.fetch.bind(window);

  // ---------------------------------------------------------------- libs
  // Carregadas só quando uma ferramenta precisa, para a página inicial
  // continuar leve.
  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => {
          delete scripts[src];
          reject(userError('Não foi possível carregar um componente do site. Verifique sua conexão e tente de novo.'));
        };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }
  async function pdfLib() { await loadScript('/vendor/pdf-lib.min.js'); return window.PDFLib; }
  async function jsZip() { await loadScript('/vendor/jszip.min.js'); return window.JSZip; }
  async function utif() {
    await loadScript('/vendor/pako_inflate.min.js');
    await loadScript('/vendor/UTIF.js');
    return window.UTIF;
  }
  async function pdfjs() {
    await loadScript('/vendor/pdfjs/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    return window.pdfjsLib;
  }

  // ------------------------------------------------------------- helpers
  function userError(message, status = 400) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  const isPdf = f => /\.pdf$/i.test(f?.name || '') || f?.type === 'application/pdf';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Devolve o controle ao navegador entre páginas, para a barra de
  // progresso se mexer e a aba não parecer travada.
  const breathe = () => new Promise(r => setTimeout(r, 0));

  function requirePdf(file) {
    if (!file || typeof file === 'string') throw userError('Nenhum arquivo foi enviado.');
    if (!isPdf(file)) throw userError('Este recurso aceita somente PDF.');
  }

  async function openWithPdfLib(file) {
    const { PDFDocument } = await pdfLib();
    let doc;
    try {
      doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    } catch (_) {
      throw userError(`Não foi possível ler "${file.name}". O arquivo pode estar corrompido.`);
    }
    if (doc.isEncrypted) {
      throw userError(`"${file.name}" é protegido (senha ou restrições de edição). Remova a proteção antes de usar esta ferramenta.`);
    }
    return doc;
  }

  async function openWithPdfjs(file) {
    const lib = await pdfjs();
    try {
      return await lib.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        cMapUrl: '/vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/'
      }).promise;
    } catch (e) {
      if (e?.name === 'PasswordException') throw userError(`"${file.name}" é protegido por senha.`);
      throw userError(`Não foi possível ler "${file.name}". O arquivo pode estar corrompido.`);
    }
  }

  // Navegadores (principalmente no iPhone) não desenham canvas acima de
  // ~16,7 milhões de pixels - acima disso a imagem sai em branco.
  const MAX_CANVAS_PIXELS = 16_000_000;
  function fitScale(width, height, wanted) {
    const area = width * wanted * height * wanted;
    return area > MAX_CANVAS_PIXELS ? wanted * Math.sqrt(MAX_CANVAS_PIXELS / area) : wanted;
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, ctx };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
      b => b ? resolve(b) : reject(userError('O navegador não conseguiu gerar a imagem (memória insuficiente?).', 500)),
      type, quality));
  }

  function freeCanvas(canvas) { canvas.width = 0; canvas.height = 0; }

  async function renderPage(doc, pageNumber, scaleFor) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: scaleFor(base.width, base.height) });
    const { canvas, ctx } = makeCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    return { canvas, width: base.width, height: base.height };
  }

  /** Mesma regra do servidor: "1-3,5,8-10" -> [[0,1,2],[4],[7,8,9]] */
  function parseRanges(str, pageCount) {
    if (!String(str || '').trim()) return [];
    return String(str).split(',').map(raw => {
      const part = raw.trim();
      const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) throw userError(`Intervalo inválido: ${part}`);
      const start = Number(m[1]);
      const end = Number(m[2] || m[1]);
      if (start < 1 || end < start || start > pageCount) throw userError(`Página inválida no intervalo: ${part}`);
      const arr = [];
      for (let p = start; p <= Math.min(end, pageCount); p++) arr.push(p - 1);
      return arr;
    });
  }

  const fileResponse = (data, type) => new Response(data instanceof Blob ? data : new Blob([data], { type }), {
    status: 200, headers: { 'Content-Type': type }
  });
  const errorResponse = (message, status) => new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' }
  });

  // ------------------------------------------------------------- ferramentas
  async function merge(fd, progress) {
    const files = fd.getAll('files').filter(f => typeof f !== 'string');
    if (files.length < 2) throw userError('Selecione pelo menos 2 PDFs.');
    files.forEach(requirePdf);
    const { PDFDocument } = await pdfLib();
    const out = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      const src = await openWithPdfLib(files[i]);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
      progress((i + 1) / files.length * 0.9);
      await breathe();
    }
    return fileResponse(await out.save(), 'application/pdf');
  }

  async function split(fd, progress) {
    const file = fd.get('file');
    requirePdf(file);
    const src = await openWithPdfLib(file);
    const ranges = parseRanges(fd.get('ranges'), src.getPageCount());
    const groups = ranges.length ? ranges : src.getPageIndices().map(i => [i]);
    if (groups.length > 100) throw userError('Limite de 100 partes por operação.');
    const { PDFDocument } = await pdfLib();
    const zip = new (await jsZip())();
    for (let i = 0; i < groups.length; i++) {
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, groups[i]);
      pages.forEach(p => doc.addPage(p));
      zip.file(`parte_${i + 1}.pdf`, await doc.save());
      progress((i + 1) / groups.length * 0.85);
      await breathe();
    }
    return fileResponse(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), 'application/zip');
  }

  async function pagesEdit(fd, progress) {
    const file = fd.get('file');
    requirePdf(file);
    const src = await openWithPdfLib(file);
    let ops;
    try { ops = JSON.parse(fd.get('operations') || '{}'); } catch (_) { throw userError('Operações inválidas.'); }
    const pageCount = src.getPageCount();
    let order = Array.isArray(ops.keepOrder) ? ops.keepOrder.map(Number).map(n => n - 1) : src.getPageIndices();
    const deleted = new Set((Array.isArray(ops.delete) ? ops.delete : []).map(Number).map(n => n - 1));
    if (order.some(i => !Number.isInteger(i) || i < 0 || i >= pageCount)) throw userError('Ordem de páginas inválida.');
    order = order.filter(i => !deleted.has(i));
    if (!order.length) throw userError('O PDF final precisa ter pelo menos uma página.');
    progress(0.3);
    const { PDFDocument, degrees } = await pdfLib();
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, order);
    pages.forEach((page, idx) => {
      const rotation = Number(ops.rotations?.[order[idx] + 1] || 0);
      if (rotation) page.setRotation(degrees(((page.getRotation().angle + rotation) % 360 + 360) % 360));
      out.addPage(page);
    });
    progress(0.8);
    return fileResponse(await out.save(), 'application/pdf');
  }

  /** Abre qualquer imagem aceita e devolve um canvas com fundo branco. */
  async function imageToCanvas(file) {
    if (/\.tiff?$/i.test(file.name) || file.type === 'image/tiff') {
      const U = await utif();
      const buf = await file.arrayBuffer();
      const ifds = U.decode(buf);
      if (!ifds.length) throw userError(`Não foi possível abrir a imagem "${file.name}".`);
      U.decodeImage(buf, ifds[0]);
      const { width, height } = ifds[0];
      const rgba = new Uint8ClampedArray(U.toRGBA8(ifds[0]).buffer);
      const raw = makeCanvas(width, height);
      raw.ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
      const scale = fitScale(width, height, 1);
      if (scale === 1) {
        // putImageData ignora o fundo branco - redesenha por cima dele.
        const out = makeCanvas(width, height);
        out.ctx.drawImage(raw.canvas, 0, 0);
        freeCanvas(raw.canvas);
        return { canvas: out.canvas, width, height };
      }
      const out = makeCanvas(width * scale, height * scale);
      out.ctx.drawImage(raw.canvas, 0, 0, out.canvas.width, out.canvas.height);
      freeCanvas(raw.canvas);
      return { canvas: out.canvas, width, height };
    }

    // <img> já aplica a rotação EXIF das fotos de celular (equivale ao
    // sharp().rotate() que o servidor usava).
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch (_) {
        throw userError(`Não foi possível abrir a imagem "${file.name}". Formatos aceitos: JPG, PNG, WEBP, GIF, BMP e TIFF.`);
      }
      const width = img.naturalWidth, height = img.naturalHeight;
      const scale = fitScale(width, height, 1);
      const { canvas, ctx } = makeCanvas(width * scale, height * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { canvas, width, height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function imagesToPdf(fd, progress) {
    const files = fd.getAll('files').filter(f => typeof f !== 'string');
    if (!files.length) throw userError('Selecione pelo menos uma imagem.');
    const { PDFDocument } = await pdfLib();
    const doc = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      const { canvas, width, height } = await imageToCanvas(files[i]);
      const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.9);
      freeCanvas(canvas);
      const img = await doc.embedJpg(await jpg.arrayBuffer());
      // Página do tamanho da imagem original, como no servidor.
      const page = doc.addPage([width, height]);
      page.drawImage(img, { x: 0, y: 0, width, height });
      progress((i + 1) / files.length * 0.9);
      await breathe();
    }
    return fileResponse(await doc.save(), 'application/pdf');
  }

  async function pdfToImages(fd, progress) {
    const file = fd.get('file');
    requirePdf(file);
    const format = String(fd.get('format') || 'png').toLowerCase();
    if (!['png', 'jpg', 'jpeg'].includes(format)) throw userError('Formato de imagem inválido.');
    const isPng = format === 'png';
    const doc = await openWithPdfjs(file);
    const zip = new (await jsZip())();
    const digits = String(doc.numPages).length;
    const DPI_SCALE = 150 / 72; // mesma resolução do servidor (150 DPI)
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        const { canvas } = await renderPage(doc, p, (w, h) => fitScale(w, h, DPI_SCALE));
        const blob = await canvasToBlob(canvas, isPng ? 'image/png' : 'image/jpeg', 0.88);
        freeCanvas(canvas);
        zip.file(`pagina-${String(p).padStart(digits, '0')}.${isPng ? 'png' : 'jpg'}`, blob);
        progress(p / doc.numPages * 0.85);
      }
    } finally {
      doc.destroy();
    }
    return fileResponse(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), 'application/zip');
  }

  /** Miniaturas e contagem de páginas para Juntar, Dividir e Organizar. */
  async function inspect(fd, progress) {
    const file = fd.get('file');
    requirePdf(file);
    const firstPageOnly = fd.get('firstPageOnly') === '1';
    const doc = await openWithPdfjs(file);
    const THUMB_MAX_SIDE = 700;
    const thumbnails = [];
    const pageSizes = [];
    try {
      const total = firstPageOnly ? 1 : doc.numPages;
      for (let p = 1; p <= total; p++) {
        const { canvas, width, height } = await renderPage(doc, p, (w, h) => THUMB_MAX_SIDE / Math.max(w, h));
        thumbnails.push(canvas.toDataURL('image/jpeg', 0.76));
        freeCanvas(canvas);
        pageSizes.push({ width, height });
        progress(p / total * 0.95);
      }
      return new Response(JSON.stringify({ fileId: null, pageCount: doc.numPages, pageSizes, thumbnails, textBoxes: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } finally {
      doc.destroy();
    }
  }

  const LOCAL_ROUTES = {
    '/api/merge': merge,
    '/api/split': split,
    '/api/pages/edit': pagesEdit,
    '/api/convert/images-to-pdf': imagesToPdf,
    '/api/convert/pdf-to-images': pdfToImages,
    // O editor precisa que o PDF fique guardado no servidor (fileId) para
    // salvar as edições depois - lá a análise continua remota.
    ...(onEditorPage ? {} : { '/api/inspect': inspect })
  };

  /**
   * Se a chamada pode ser feita no navegador, devolve uma função
   * (onProgress) => Promise<Response>; senão, null.
   */
  function localHandler(url, init = {}) {
    if (typeof url !== 'string') return null;
    const run = LOCAL_ROUTES[url.split('?')[0]];
    if (!run || (init.method || 'GET').toUpperCase() !== 'POST' || !(init.body instanceof FormData)) return null;
    return async (onProgress = () => {}) => {
      try {
        const res = await run(init.body, f => { try { onProgress(Math.max(0, Math.min(1, f))); } catch (_) {} });
        onProgress(1);
        return res;
      } catch (e) {
        console.error('[PDFTools local]', e);
        return errorResponse(e.status ? e.message : `Falha ao processar no navegador: ${e.message}`, e.status || 500);
      }
    };
  }

  // ------------------------------------------------------- servidor remoto
  const remoteUrl = url => (typeof url === 'string' && url.startsWith('/api/')) ? API_BASE + url : url;

  // Depois de uma resposta, o servidor fica acordado por ~15 min. Usamos 10
  // para não arriscar pular o aviso justo quando ele voltou a dormir.
  let awakeUntil = 0;
  let waking = null;
  const markAwake = () => { awakeUntil = Date.now() + 10 * 60 * 1000; };

  let banner = null;
  function showWakeBanner(show) {
    if (show && !banner) {
      banner = document.createElement('div');
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;max-width:min(92vw,460px);padding:12px 16px;border-radius:10px;background:#1f2630;color:#f3e9dd;font:13px/1.45 Arial,Helvetica,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);text-align:center';
      banner.textContent = 'Acordando o servidor de conversão… No primeiro uso depois de um tempo parado, isso pode levar até 1 minuto.';
      document.body.appendChild(banner);
    } else if (!show && banner) {
      banner.remove();
      banner = null;
    }
  }

  async function pingHealth() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 75000);
    try {
      const r = await nativeFetch(`${API_BASE}/api/health`, { cache: 'no-store', signal: ctrl.signal });
      return r.ok;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Garante que o servidor está de pé antes de enviar um arquivo.
   * onWaking: chamado se estiver demorando (servidor dormindo). Sem ele,
   * mostra um aviso flutuante.
   */
  function ensureAwake(onWaking) {
    if (Date.now() < awakeUntil) return Promise.resolve();
    if (!waking) {
      waking = (async () => {
        const started = Date.now();
        let warned = false;
        const warn = () => { warned = true; onWaking ? onWaking() : showWakeBanner(true); };
        const timer = setTimeout(warn, 2500);
        try {
          while (!(await pingHealth())) {
            if (Date.now() - started > 150000) {
              throw new Error('O servidor de conversão não respondeu. Tente novamente em alguns instantes.');
            }
            if (!warned) { clearTimeout(timer); warn(); }
            await sleep(3000);
          }
          markAwake();
        } finally {
          clearTimeout(timer);
          showWakeBanner(false);
          waking = null;
        }
      })();
    } else {
      // Já tem alguém acordando o servidor (ex: o pré-aquecimento ao abrir a
      // ferramenta) - avisa este chamador também.
      const joined = waking;
      const t = setTimeout(() => { if (waking === joined) onWaking ? onWaking() : showWakeBanner(true); }, 1500);
      joined.then(() => clearTimeout(t), () => clearTimeout(t));
    }
    return waking;
  }

  /** Começa a acordar o servidor sem bloquear nada (ao abrir uma ferramenta remota). */
  function warmUp() {
    ensureAwake(() => {}).catch(() => {});
  }

  // ------------------------------------------------------------ fetch
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : '';
    const local = localHandler(url, init);
    if (local) return local();
    if (url.startsWith('/api/')) {
      await ensureAwake();
      const res = await nativeFetch(remoteUrl(url), init);
      markAwake();
      return res;
    }
    return nativeFetch(input, init);
  };

  window.PDFTools = { API_BASE, localHandler, remoteUrl, ensureAwake, markAwake, warmUp };

  if (onEditorPage) warmUp();
})();
