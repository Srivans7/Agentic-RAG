export async function POST(req: Request) {
  try {
    const arrayBuffer = await req.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    // Primary: try to load pdf-parse at runtime to avoid build-time
    // evaluation by Turbopack (some versions read test fixtures at import).
    try {
      // eslint-disable-next-line no-new-func
      const dynamicImport: any = Function("specifier", "return import(specifier)");
      let pdfModule: any;

      try {
        pdfModule = await dynamicImport("pdf-parse");
      } catch (importErr) {
        try {
          const require = (await Promise.resolve()).constructor ? require : undefined; // noop for type clarity
          // fallback to createRequire in environments that support CJS require
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { createRequire } = await dynamicImport("module");
          const req = createRequire(import.meta.url);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          pdfModule = req("pdf-parse");
        } catch (requireErr) {
          // eslint-disable-next-line no-console
          console.info("api/pdf-parse: pdf-parse dynamic import and require fallback both failed", {
            importErr: (importErr as any)?.message ?? String(importErr),
            requireErr: (requireErr as any)?.message ?? String(requireErr),
          });
          pdfModule = null;
        }
      }

      if (pdfModule) {
        const pdf = (pdfModule as any).default ?? pdfModule;
        try {
          const parsed = await pdf(bytes);
          if (parsed?.text && String(parsed.text).trim()) {
            return new Response(JSON.stringify({ text: String(parsed.text).trim() }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
        } catch (runErr) {
          // eslint-disable-next-line no-console
          console.info("api/pdf-parse: pdf-parse execution failed, falling back to pdfjs", { err: (runErr as any)?.message ?? String(runErr) });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.info("api/pdf-parse: unexpected error while attempting to load pdf-parse", { err: (err as any)?.message ?? String(err) });
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
