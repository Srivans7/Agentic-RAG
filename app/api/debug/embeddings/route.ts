import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { env } from "@/lib/env";
import { getErrorMessage } from "@/lib/utils";

export async function GET() {
  try {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY (or GEMINI_API_KEY) in server env" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const model = env.OPENAI_MODEL || "text-embedding-004";
    const embeddings = new GoogleGenerativeAIEmbeddings({ apiKey, model });

    const samples = ["hello world", "embedding test"];
    const vectors: unknown = await embeddings.embedDocuments(samples);

    const lengths = Array.isArray(vectors) ? (vectors as any[]).map((v) => (Array.isArray(v) ? v.length : null)) : null;
    const preview = Array.isArray(vectors) && Array.isArray(vectors[0]) ? (vectors[0] as number[]).slice(0, 8) : null;

    return new Response(
      JSON.stringify({ lengths, preview, model }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: getErrorMessage(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
