/*
 * Página que hospeda o PDF Bigode (em /editor) dentro do meupdf.
 *
 * Conversa com ele pela ponte de mensagens que o próprio PDF Bigode oferece
 * quando aberto com "?host=parent" (veja apps/pdfbigode-web/src/main.rs):
 *   pdfbigode:ready  -> o editor carregou: some a tela de carregamento
 *   pdfbigode:failed -> não conseguiu iniciar (ex: navegador sem WebGL)
 *   pdfbigode:save   -> { name, saveAs, bytes }: a pessoa salvou; aqui gravamos o arquivo
 * Avisar sobre alterações não salvas fica com o próprio editor (beforeunload).
 */
(() => {
  const frame = document.getElementById('edFrame');
  const loader = document.getElementById('edLoader');
  const loaderTitle = document.getElementById('edLoaderTitle');
  const loaderHint = document.getElementById('edLoaderHint');
  const toastEl = document.getElementById('toast');
  let ready = false;

  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.className = 'toast'; }, 3600);
  }

  function showError(title, hint) {
    loader.classList.remove('hidden');
    loader.classList.add('error');
    loaderTitle.textContent = title;
    loaderHint.textContent = hint;
  }

  const safeName = name => {
    const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_') || 'documento.pdf';
    return /\.pdf$/i.test(clean) ? clean : clean + '.pdf';
  };

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  // Onde cada documento foi salvo, para "Salvar" (Ctrl+S) gravar de novo no
  // mesmo arquivo sem perguntar. Só existe nos navegadores com o seletor de
  // arquivos nativo (Chrome/Edge); nos outros, cada salvamento baixa o PDF.
  const handles = new Map();

  async function save({ name, saveAs, bytes }) {
    const fileName = safeName(name);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    let handle = !saveAs && handles.get(fileName);

    if (!handle && typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          toast('Salvamento cancelado: o arquivo não foi gravado.', true);
          return;
        }
        // Sem o clique recente que o navegador exige (salvamento demorado,
        // por exemplo): cai para o download comum.
        handle = null;
      }
    }

    if (handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        handles.set(fileName, handle);
        toast(`PDF salvo: ${handle.name}`);
        return;
      } catch (err) {
        console.warn('Não deu para gravar no arquivo escolhido; baixando:', err);
        handles.delete(fileName);
      }
    }
    download(fileName, blob);
    toast(`PDF baixado: ${fileName}`);
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const data = event.data || {};
    switch (data.type) {
      case 'pdfbigode:ready':
        ready = true;
        loader.classList.add('hidden');
        break;
      case 'pdfbigode:failed':
        showError('O editor não conseguiu iniciar neste navegador.',
          `Ele precisa de WebGL ativado. Tente atualizar o navegador ou usar o Chrome, Edge ou Firefox. (${data.error || 'erro desconhecido'})`);
        break;
      case 'pdfbigode:save':
        save(data).catch(err => toast(`Não foi possível salvar: ${err.message}`, true));
        break;
    }
  });

  setTimeout(() => {
    if (!ready) loaderHint.textContent = 'Está demorando mais que o normal. Conexões lentas podem levar até um minuto no primeiro acesso.';
  }, 30000);
})();
