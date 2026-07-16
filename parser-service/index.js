const express = require('express');
const bodyParser = require('body-parser');

async function runPdfParse(bytes) {
  try {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(bytes);
    if (parsed && parsed.text && parsed.text.trim()) {
      return parsed.text.trim();
    }
    return '';
  } catch (err) {
    console.error('parser-service: pdf-parse failed', err?.message ?? err);
    // fallback to pdfjs-dist
    try {
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      const loadingTask = pdfjs.getDocument({ data: bytes });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages || 0;
      const extracted = [];
      for (let p = 1; p <= numPages; p += 1) {
        const page = await pdfDoc.getPage(p);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => (item.str ? String(item.str) : '')).join(' ');
        if (pageText.trim()) extracted.push(pageText.trim());
      }
      return extracted.join('\n\n').trim();
    } catch (e) {
      console.error('parser-service: pdfjs fallback failed', e?.message ?? e);
      throw e;
    }
  }
}

const app = express();

app.use(bodyParser.raw({ type: '*/*', limit: '50mb' }));

app.post('/parse', async (req, res) => {
  try {
    const bytes = req.body;
    if (!bytes || !bytes.length) {
      return res.status(400).json({ error: 'No file bytes received' });
    }

    const text = await runPdfParse(bytes);
    return res.json({ text });
  } catch (err) {
    console.error('parser-service: unexpected error', err?.message ?? err);
    return res.status(500).json({ error: 'Failed to parse PDF' });
  }
});

app.get('/', (req, res) => {
  res.send('parser-service: up');
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, () => console.log(`parser-service listening on ${port}`));
