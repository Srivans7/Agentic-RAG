import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import { env } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getErrorMessage } from "@/lib/utils";
import type { RagAnswerResult, RagIndexInput, RagIndexResult, RagMatch, RagQueryInput } from "@/types";

const STORAGE_BUCKET_NAME = "knowledge-files";
const VECTOR_TABLE_NAME = "documents";
const VECTOR_QUERY_NAME = "match_documents";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-004";
const DEFAULT_CHAT_MODEL = "gemini-2.5-flash";

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function normalizeGeneratedContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part) {
          const candidate = part as { text?: unknown };
          return typeof candidate.text === "string" ? candidate.text : "";
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function normalizeQueryTerms(query: string) {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2);
}

function getFileExtension(fileName: string) {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

async function extractDocumentText(fileName: string, fileBuffer: ArrayBuffer | Uint8Array | Blob) {
  const extension = getFileExtension(fileName);
  const buffer = fileBuffer instanceof Blob ? await fileBuffer.arrayBuffer() : fileBuffer;
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;

    if (extension === "pdf") {
      try {
        // Use a runtime-evaluated dynamic import to avoid bundlers (Turbopack)
        // statically analyzing and executing `pdf-parse` at build time
        // (which can cause it to read test fixtures like './test/data/...').
        // Wrapping the import in `new Function` prevents static bundling.
        // eslint-disable-next-line no-new-func
        const dynamicImport: (specifier: string) => Promise<any> = new Function(
          'specifier',
          'return import(specifier)'
        );

        const pdfModule = await dynamicImport("pdf-parse");
        const pdf = (pdfModule as any).default ?? pdfModule;
        const parsed = await pdf(Buffer.from(bytes));
        if (parsed.text && parsed.text.trim()) {
          return parsed.text.trim();
        }
        // If pdf-parse returned empty text, surface a detailed error below.
        const detail = `pdf-parse produced empty text for ${fileName}`;
        // eslint-disable-next-line no-console
        console.error("ragService.extractDocumentText: pdf-parse returned empty text", {
          fileName,
          detail,
          parsedSummary: {
            numPages: (parsed && (parsed as any).numpages) ?? null,
            info: (parsed && (parsed as any).info) ?? null,
          },
        });
        throw new Error(detail);
      } catch (err: any) {
        // Log full error details (message + stack) to help debugging in server logs.
        // eslint-disable-next-line no-console
        console.error("ragService.extractDocumentText: pdf-parse failed", {
          fileName,
          message: err?.message ?? String(err),
          stack: err?.stack ?? null,
          error: err,
        });

        throw new Error(`Failed to parse PDF content: ${err?.message ?? String(err)}`);
      }
    }

  const decoder = new TextDecoder("utf-8");
  return decoder.decode(bytes).trim();
}

function rankChunksByQueryTerms(
  docs: Array<{ pageContent: string; metadata: Record<string, unknown> }>,
  query: string,
) {
  const terms = normalizeQueryTerms(query);

  return docs.map((doc, index) => {
    const normalizedChunk = doc.pageContent.toLowerCase();
    const score = terms.reduce((total, term) => {
      return total + (normalizedChunk.includes(term) ? 1 : 0);
    }, 0);

    return {
      content: doc.pageContent,
      metadata: doc.metadata,
      score: score || Math.max(0, 0.25 - index * 0.01),
    } satisfies RagMatch;
  });
}

export class LangChainRagService {
  private readonly splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1200,
    chunkOverlap: 200,
  });

  private getApiKey() {
    return env.OPENAI_API_KEY;
  }

  private getChatModelName(requestedModel?: string) {
    const candidate = requestedModel ?? env.OPENAI_MODEL;
    return candidate.startsWith("gemini") ? candidate : DEFAULT_CHAT_MODEL;
  }

  private createEmbeddings() {
    const apiKey = this.getApiKey();

    if (!apiKey) {
      throw new Error("Missing `GEMINI_API_KEY` (or `OPENAI_API_KEY`) in `.env.local`.");
    }

    return new GoogleGenerativeAIEmbeddings({
      apiKey,
      model: DEFAULT_EMBEDDING_MODEL,
    });
  }

  private createChatModel(requestedModel?: string) {
    const apiKey = this.getApiKey();

    if (!apiKey) {
      throw new Error("Missing `GEMINI_API_KEY` (or `OPENAI_API_KEY`) in `.env.local`.");
    }

    return new ChatGoogleGenerativeAI({
      apiKey,
      model: this.getChatModelName(requestedModel),
      temperature: 0.2,
    });
  }

  private async getVectorStore(filter?: Record<string, unknown>) {
    const client = createSupabaseAdminClient();

    return SupabaseVectorStore.fromExistingIndex(this.createEmbeddings(), {
      client,
      tableName: VECTOR_TABLE_NAME,
      queryName: VECTOR_QUERY_NAME,
      filter,
    });
  }

  private async selectRelevantTextChunks(input: {
    rawText: string;
    query: string;
    metadata: Record<string, unknown>;
    limit?: number;
  }): Promise<RagMatch[]> {
    const docs = await this.splitter.createDocuments([input.rawText], [input.metadata]);
    if (!docs.length) {
      return [];
    }

    try {
      const embeddings = this.createEmbeddings();
      const queryText = input.metadata.fileName
        ? `${input.query}\nAttached file: ${String(input.metadata.fileName)}`
        : input.query;
      const [queryEmbedding, docEmbeddings] = await Promise.all([
        embeddings.embedQuery(queryText),
        embeddings.embedDocuments(docs.map((doc) => doc.pageContent)),
      ]);

      const ranked = docs.map((doc, index) => ({
        content: doc.pageContent,
        metadata: doc.metadata as Record<string, unknown>,
        score: cosineSimilarity(queryEmbedding, docEmbeddings[index] ?? []),
      } satisfies RagMatch));

      return ranked
        .sort((left, right) => right.score - left.score)
        .slice(0, input.limit ?? 4);
    } catch {
      const ranked = rankChunksByQueryTerms(
        docs.map((doc) => ({
          pageContent: doc.pageContent,
          metadata: doc.metadata as Record<string, unknown>,
        })),
        input.query,
      );

      return ranked
        .sort((left, right) => right.score - left.score)
        .slice(0, input.limit ?? 4);
    }
  }

  private async generateAnswerFromMatches(input: RagQueryInput, matches: RagMatch[]): Promise<RagAnswerResult> {
    if (!matches.length) {
      return {
        answer:
          "I couldn't find relevant context in your uploaded files yet. Upload a `.md` or `.txt` file and try again.",
        matches: [],
      };
    }

    const context = matches
      .map(
        (match, index) =>
          `Source ${index + 1} — ${String(match.metadata.fileName ?? "uploaded document")}\n${match.content}`,
      )
      .join("\n\n");

    try {
      const llm = this.createChatModel(input.model) as unknown as {
        invoke: (prompt: string) => Promise<{ content: unknown }>;
      };
      const response = await llm.invoke(`You are a retrieval-augmented assistant. Use only the context below to answer the user's question. If the answer is not in the context, say that clearly and do not fabricate facts.\n\nQuestion:\n${input.query}\n\nContext:\n${context}`);

      const answer = normalizeGeneratedContent(response.content).trim();

      return {
        answer: answer || "I found relevant context but could not generate a full answer.",
        matches,
      };
    } catch (error) {
      const fallback = matches
        .map(
          (match, index) =>
            `Source ${index + 1}: ${String(match.metadata.fileName ?? "uploaded document")}\n${match.content.slice(0, 240)}...`,
        )
        .join("\n\n");

      return {
        answer:
          `I found relevant context, but the model call failed. Review these retrieved chunks:\n\n${fallback}`,
        matches,
        warning: getErrorMessage(error),
      };
    }
  }

  async loadTextFromStorage(
  input: Pick<RagIndexInput, "storagePath" | "bucketName"> & { fileName?: string },
) {
    const admin = createSupabaseAdminClient();
    const bucketName = input.bucketName ?? STORAGE_BUCKET_NAME;
    const { data, error } = await admin.storage.from(bucketName).download(input.storagePath);

    if (error || !data) {
      // Log download failures for easier debugging in server logs.
      // Include context so we can correlate with uploaded_files rows and user actions.
      // eslint-disable-next-line no-console
      console.error("ragService.loadTextFromStorage: failed to download file", {
        bucketName,
        storagePath: input.storagePath,
        fileName: input.fileName,
        error: error ?? null,
      });

      throw error ?? new Error("Unable to download the uploaded file from Supabase storage.");
    }

    // Normalize downloaded data to an ArrayBuffer so downstream parsing
    // works consistently across Node, Edge and serverless runtimes where
    // Supabase storage may return a Blob, Buffer, ReadableStream, or
    // a Response-like body. Wrapping with `Response` is a reliable
    // way to obtain an ArrayBuffer from many body types.
    let normalizedBuffer: ArrayBuffer;

    try {
      if (typeof (data as any).arrayBuffer === "function") {
        normalizedBuffer = await (data as any).arrayBuffer();
      } else {
        // Fallback: wrap in a Response and extract an ArrayBuffer.
        // Node 18+ and modern runtimes provide a global `Response`.
        // This handles ReadableStream, Buffer, and other body types.
        // eslint-disable-next-line no-undef
        normalizedBuffer = await new Response(data as any).arrayBuffer();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("ragService.loadTextFromStorage: failed to normalize downloaded file to ArrayBuffer", {
        fileName: input.fileName,
        storagePath: input.storagePath,
        bucketName,
        error: err,
      });

      throw new Error("Unable to read the uploaded file from storage.");
    }

    const text = await extractDocumentText(input.fileName ?? input.storagePath, normalizedBuffer);


    if (!text.trim()) {
      // Log unexpected empty extractions (e.g., binary PDF parsing failures)
      // eslint-disable-next-line no-console
      console.error("ragService.loadTextFromStorage: extracted text is empty", {
        fileName: input.fileName,
        storagePath: input.storagePath,
        bucketName,
      });

      throw new Error("The uploaded file is empty.");
    }

    return text;
  }

  async indexUploadedFile(input: RagIndexInput): Promise<RagIndexResult> {
    const rawText = await this.loadTextFromStorage({
      storagePath: input.storagePath,
      bucketName: input.bucketName,
      fileName: input.fileName,
    });
    const docs = await this.splitter.createDocuments([rawText], [
      {
        userId: input.userId,
        fileId: input.fileId,
        fileName: input.fileName,
        storagePath: input.storagePath,
        bucketName: input.bucketName ?? STORAGE_BUCKET_NAME,
      },
    ]);

    const vectorStore = await this.getVectorStore();
    const ids = docs.map((_, index) => `${input.fileId}-${index}`);

    try {
      await vectorStore.addDocuments(docs, { ids });
    } catch (err) {
      // Log indexing failures with context (embedding/vector store issues)
      // eslint-disable-next-line no-console
      console.error("ragService.indexUploadedFile: failed to add documents to vector store", {
        fileId: input.fileId,
        fileName: input.fileName,
        storagePath: input.storagePath,
        bucketName: input.bucketName,
        chunkCount: docs.length,
        error: err,
      });

      throw err;
    }

    return {
      fileId: input.fileId,
      chunkCount: docs.length,
      message: `${input.fileName} indexed into ${docs.length} chunks.`,
    };
  }

  async retrieveRelevantChunks(input: RagQueryInput): Promise<RagMatch[]> {
    const filter = {
      userId: input.userId,
      ...(input.fileId ? { fileId: input.fileId } : {}),
    };
    const vectorStore = await this.getVectorStore(filter);
    const queryText = input.fileName ? `${input.query}\nAttached file: ${input.fileName}` : input.query;
    const queryEmbedding = await this.createEmbeddings().embedQuery(queryText);
    try {
      const matches = (await vectorStore.similaritySearchVectorWithScore(
        queryEmbedding,
        input.matchCount ?? 4,
        filter,
      )) as Array<[{ pageContent: string; metadata: Record<string, unknown> }, number]>;

      return matches.map(([doc, score]) => ({
        content: doc.pageContent,
        metadata: doc.metadata as Record<string, unknown>,
        score,
      }));
    } catch (err) {
      // Log retrieval failures (vector query, permission, or query function issues)
      // eslint-disable-next-line no-console
      console.error("ragService.retrieveRelevantChunks: vector similarity search failed", {
        userId: input.userId,
        fileId: input.fileId ?? null,
        fileName: input.fileName ?? null,
        query: input.query,
        error: err,
      });

      throw err;
    }
  }

  async answerQuestionFromFile(
    input: RagQueryInput & { storagePath: string; bucketName?: string },
  ): Promise<RagAnswerResult> {
    if (input.fileId) {
      try {
        const indexedMatches = await this.retrieveRelevantChunks(input);

        if (indexedMatches.length) {
          return this.generateAnswerFromMatches(input, indexedMatches);
        }
      } catch {
        // Fall back to in-memory retrieval for files that have not been indexed yet.
      }
    }

    const rawText = await this.loadTextFromStorage({
      storagePath: input.storagePath,
      bucketName: input.bucketName,
      fileName: input.fileName ?? input.storagePath,
    });

    const matches = await this.selectRelevantTextChunks({
      rawText,
      query: input.query,
      metadata: {
        userId: input.userId,
        fileId: input.fileId,
        fileName: input.fileName,
        storagePath: input.storagePath,
        bucketName: input.bucketName ?? STORAGE_BUCKET_NAME,
      },
      limit: input.matchCount ?? 4,
    });

    return this.generateAnswerFromMatches(input, matches);
  }

  async answerQuestion(input: RagQueryInput): Promise<RagAnswerResult> {
    const matches = await this.retrieveRelevantChunks(input);
    return this.generateAnswerFromMatches(input, matches);
  }
}

export const ragService = new LangChainRagService();
