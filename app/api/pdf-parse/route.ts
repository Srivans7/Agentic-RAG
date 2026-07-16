import pdfParse from "pdf-parse";

export async function POST(req: Request) {
  try {
    const arrayBuffer = await req.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    // Primary: pdf-parse
    try {
      const parsed = await (pdfParse as any)(bytes);
      if (parsed?.text && String(parsed.text).trim()) {
        return new Response(JSON.stringify({ text: String(parsed.text).trim() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (err) {
      // fall through to pdfjs fallback
      // eslint-disable-next-line no-console
      console.info("api/pdf-parse: pdf-parse failed, falling back to pdfjs", { err: (err as any)?.message ?? String(err) });
    }

    // Fallback: pdfjs-dist text extraction (dynamically imported to avoid
    // Turbopack/Next.js build-time resolution errors for some pdfjs versions)
    try {
      // eslint-disable-next-line no-new-func
      const dynamicImport: any = Function("specifier", "return import(specifier)");
      let pdfjs: any;
      try {
        pdfjs = (await dynamicImport("pdfjs-dist/legacy/build/pdf.js")).default ?? (await dynamicImport("pdfjs-dist/legacy/build/pdf.js"));
      } catch (dynErr) {
        // Try a simpler entry if the legacy path isn't present in the installed package
        try {
          pdfjs = (await dynamicImport("pdfjs-dist")).default ?? (await dynamicImport("pdfjs-dist"));
        } catch (dynErr2) {
          // eslint-disable-next-line no-console
          console.error("api/pdf-parse: dynamic import of pdfjs-dist failed", { dynErr, dynErr2 });
          return new Response(JSON.stringify({ error: "Failed to parse PDF (pdfjs load failed)" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }

      const loadingTask = pdfjs.getDocument({ data: bytes });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages || 0;
      const extracted: string[] = [];

      for (let p = 1; p <= numPages; p += 1) {
        const page = await pdfDoc.getPage(p);
        const content = await page.getTextContent();
        const pageText = content.items.map((item: any) => (item.str ? String(item.str) : "")).join(" ");
        if (pageText.trim()) extracted.push(pageText.trim());
      }

      const full = extracted.join("\n\n").trim();
      return new Response(JSON.stringify({ text: full }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (pdfjsErr) {
      // eslint-disable-next-line no-console
      console.error("api/pdf-parse: pdfjs fallback failed", { message: (pdfjsErr as any)?.message ?? String(pdfjsErr), stack: (pdfjsErr as any)?.stack ?? null });
      return new Response(JSON.stringify({ error: "Failed to parse PDF" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("api/pdf-parse: unexpected error", { error: err });
    return new Response(JSON.stringify({ error: String((err as any) ?? err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
