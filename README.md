# PDFTools 3

Nova versão do PDFTools publicada como **Static Site** no Render: não dorme e abre na hora, mesmo no plano gratuito.

## Onde cada ferramenta roda

| Ferramenta | Onde roda |
|---|---|
| Juntar PDFs | Navegador (pdf-lib) |
| Dividir PDF | Navegador (pdf-lib + JSZip) |
| Organizar páginas | Navegador (pdf-lib + pdf.js para miniaturas) |
| Imagens → PDF | Navegador (canvas + pdf-lib; TIFF via UTIF.js) |
| PDF → Imagens | Navegador (pdf.js, 150 DPI) |
| Comprimir PDF | Servidor PDFTOOLS2 (Ghostscript) |
| Word/Excel/PPT ↔ PDF | Servidor PDFTOOLS2 (LibreOffice) |
| Tornar PDF editável (OCR) | Servidor PDFTOOLS2 (Google Vision / Tesseract) |
| Editor PDF Pro | Servidor PDFTOOLS2 (MuPDF + PDFBox) |

Nas ferramentas do navegador, o arquivo não sai do computador da pessoa.

## Como funciona

- `local-engine.js` intercepta as chamadas `fetch('/api/...')` que o resto do frontend já fazia:
  - rotas que dão para fazer no navegador são respondidas ali mesmo, com um `Response` igual ao do servidor;
  - as demais vão para `API_BASE` (`https://pdftools2.onrender.com`). Antes de enviar, ele acorda o servidor (que dorme após ~15 min no plano gratuito) e avisa a pessoa se estiver demorando.
- `progress-ui.js` mostra o progresso real tanto do processamento local quanto do envio ao servidor.
- As bibliotecas ficam em `vendor/` e só são baixadas quando uma ferramenta precisa delas.

O servidor PDFTOOLS2 não foi alterado. Para apontar para outro servidor, troque `API_BASE` em `local-engine.js`.

## Publicar no Render

Static Site, sem comando de build (ou `echo ok`), **Publish directory** `.`.
