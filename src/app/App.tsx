import { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload,
  FileText,
  Trash2,
  Send,
  Copy,
  Check,
  AlertCircle,
  BookOpen,
  ChevronDown,
  X,
  Loader2,
  FileSearch,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import ReactMarkdown from "react-markdown";

// ---------- Types ----------

interface UploadedDoc {
  id: string;
  name: string;
  size: number;
  type: "pdf" | "docx";
  pages: number;
  chunks: TextChunk[];
  uploadedAt: Date;
}

interface TextChunk {
  text: string;
  page: number;
  docId: string;
  docName: string;
}

interface QAMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
  timestamp: Date;
}

interface SourceRef {
  docName: string;
  excerpt: string;
  page: number;
}

// ---------- Helpers ----------

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function scoreChunk(chunk: TextChunk, queryTokens: string[]): number {
  const chunkTokens = tokenize(chunk.text);
  const chunkSet = new Set(chunkTokens);
  let score = 0;
  for (const qt of queryTokens) {
    if (chunkSet.has(qt)) score += 1;
    for (const ct of chunkTokens) {
      if (ct !== qt && ct.includes(qt)) score += 0.3;
    }
  }
  return score / Math.max(queryTokens.length, 1);
}

function splitIntoChunks(
  text: string,
  page: number,
  docId: string,
  docName: string,
  chunkSize = 350
): TextChunk[] {
  const sentences = text.split(/(?<=[.?!])\s+/);
  const chunks: TextChunk[] = [];
  let current = "";
  for (const s of sentences) {
    const candidate = current ? current + " " + s : s;
    if (candidate.length > chunkSize && current) {
      chunks.push({ text: current.trim(), page, docId, docName });
      current = s;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push({ text: current.trim(), page, docId, docName });
  return chunks;
}

// Extract text from a DOCX (which is a ZIP containing XML)
async function extractDocxText(file: File): Promise<{ chunks: TextChunk[]; pages: number }> {
  // Dynamically import JSZip-free approach: read the raw XML
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Check for ZIP signature (PK header)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("Not a valid DOCX file");
  }

  // Try to find word/document.xml content within the zip
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const xmlMatch = text.match(/<w:body>([\s\S]*?)<\/w:body>/);
  let extracted = "";

  if (xmlMatch) {
    // Strip XML tags and extract readable text
    extracted = xmlMatch[1]
      .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, "$1 ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!extracted || extracted.length < 20) {
    // Fallback: grab any readable ASCII runs from the binary
    extracted = text
      .replace(/[^\x20-\x7E\n]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/(PK|xml|rels|word|docx|Content|Type)/gi, " ")
      .trim()
      .slice(0, 3000);
  }

  const paragraphs = extracted
    .split(/\s{3,}|\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 30);

  const chunks: TextChunk[] = [];
  const itemsPerPage = Math.max(1, Math.ceil(paragraphs.length / 5));
  paragraphs.forEach((para, i) => {
    const page = Math.floor(i / itemsPerPage) + 1;
    chunks.push(...splitIntoChunks(para, page, file.name, file.name));
  });

  return { chunks, pages: Math.max(1, Math.ceil(paragraphs.length / 8)) };
}

// Extract text from PDF using PDF.js loaded from CDN
async function extractPdfText(file: File): Promise<{ chunks: TextChunk[]; pages: number }> {
  // Dynamically load PDF.js from CDN if not already loaded
  if (!(window as Window & { pdfjsLib?: unknown }).pdfjsLib) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load PDF.js"));
      document.head.appendChild(script);
    });
    const pdfjs = (window as Window & { pdfjsLib?: { GlobalWorkerOptions: { workerSrc: string } } }).pdfjsLib;
    if (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
  }

  const pdfjs = (window as Window & {
    pdfjsLib?: {
      getDocument: (opts: { data: ArrayBuffer }) => { promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: { str: string }[] }>;
        }>;
      }> };
    };
  }).pdfjsLib;

  if (!pdfjs) throw new Error("PDF.js unavailable");

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const chunks: TextChunk[] = [];
  const docId = `${file.name}-${Date.now()}`;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 20) {
      chunks.push(...splitIntoChunks(text, p, docId, file.name));
    }
  }

  return { chunks, pages: pdf.numPages };
}

function retrieveRelevantChunks(query: string, allChunks: TextChunk[], topN = 6): TextChunk[] {
  const queryTokens = tokenize(query);
  const scored = allChunks
    .map((c) => ({ chunk: c, score: scoreChunk(c, queryTokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.chunk);
}

interface SourceGroup {
  docName: string;
  page: number;
  text: string;
}

// Groups chunks by (document, page) in order of first appearance. This becomes
// the single source of truth for numbering: group 1 is "[Source 1]" in the
// LLM prompt AND source card [1] in the UI — they can never drift apart.
function groupChunksByPage(chunks: TextChunk[]): SourceGroup[] {
  const order: string[] = [];
  const map = new Map<string, { docName: string; page: number; texts: string[] }>();
  for (const c of chunks) {
    const key = `${c.docName}-${c.page}`;
    if (!map.has(key)) {
      map.set(key, { docName: c.docName, page: c.page, texts: [] });
      order.push(key);
    }
    map.get(key)!.texts.push(c.text);
  }
  return order.map((key) => {
    const g = map.get(key)!;
    return { docName: g.docName, page: g.page, text: g.texts.join(" ") };
  });
}

function groupsToSources(groups: SourceGroup[]): SourceRef[] {
  return groups.map((g) => ({
    docName: g.docName,
    page: g.page,
    excerpt: g.text.slice(0, 240) + (g.text.length > 240 ? "…" : ""),
  }));
}

class GroqConfigError extends Error {}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single attempt against one specific model. Throws on any non-ok response,
// including a `retryable` flag on 429/503 so the caller knows whether to retry.
// Groq exposes an OpenAI-compatible /chat/completions endpoint.
async function callGroqModel(
  model: string,
  apiKey: string,
  prompt: string
): Promise<string> {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 1024,
      }),
    });
  } catch {
    throw new Error("Network error reaching the Groq API. Check your internet connection.");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || "";
    } catch {
      // ignore parse failure
    }
    if (response.status === 401) {
      throw new GroqConfigError("Your Groq API key looks invalid. Double-check VITE_GROQ_API_KEY in .env.");
    }
    if (response.status === 403) {
      throw new GroqConfigError("Groq API key rejected (403). It may be restricted, revoked, or missing access.");
    }
    if (response.status === 429) {
      const err = new Error("Groq rate limit hit (429).");
      (err as Error & { retryable?: boolean }).retryable = true;
      throw err;
    }
    if (response.status === 503) {
      const err = new Error("Groq is overloaded (503).");
      (err as Error & { retryable?: boolean }).retryable = true;
      throw err;
    }
    throw new Error(`Groq API error (${response.status}): ${detail || "unknown error"}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content ?? "";

  if (!text.trim()) {
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (finishReason && finishReason !== "stop") {
      throw new Error(`Groq declined to answer (reason: ${finishReason}).`);
    }
    throw new Error("Groq returned an empty response.");
  }

  return text.trim();
}

// Calls the Groq API (OpenAI-compatible chat completions endpoint) with the
// retrieved document passages as grounding context, and asks it to answer
// strictly from that context. Retries transient errors (429/503) with
// backoff, and falls back to a second model if the primary one is overloaded.
async function askGroq(query: string, sourceGroups: SourceGroup[]): Promise<string> {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY as string | undefined;

  if (!apiKey) {
    throw new GroqConfigError(
      "No Groq API key found. Add VITE_GROQ_API_KEY to your .env file and restart the dev server."
    );
  }

  const contextBlock = sourceGroups
    .map((g, i) => `[Source ${i + 1} — ${g.docName}, page ${g.page}]\n${g.text}`)
    .join("\n\n");

  const prompt = `You are a document Q&A assistant. Answer the user's question using ONLY the context excerpts below, which come from documents the user uploaded. Do not use outside knowledge. If the excerpts don't contain enough information to answer, say so clearly instead of guessing.

Keep the answer concise and directly responsive to the question. When citing, use [Source N] with the exact number shown above the excerpt — do not invent source numbers beyond what's listed.

CONTEXT EXCERPTS:
${contextBlock}

QUESTION: ${query}`;

  // Primary model first, then a fallback if it's persistently overloaded.
  const modelsToTry = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
  const maxAttemptsPerModel = 3;

  let lastError: unknown;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        return await callGroqModel(model, apiKey, prompt);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof Error && (err as Error & { retryable?: boolean }).retryable;
        if (!retryable) {
          // Config errors (bad key, 403) or unknown errors: no point retrying or falling back.
          throw err;
        }
        if (attempt < maxAttemptsPerModel) {
          // Exponential-ish backoff: 1s, 2s
          await sleep(attempt * 1000);
        }
      }
    }
    // Exhausted retries on this model — try the next model in the fallback list.
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Groq is currently unavailable. Please try again in a moment.");
}

// Above this size, sending every chunk to Groq on every question would be
// wasteful/slow, so we fall back to keyword-based retrieval. Below it (true
// for the 5-10 page docs this app is designed for), just send everything —
// keyword pre-filtering can miss relevant passages that don't share exact
// words with the question (e.g. "key findings" vs. "achieved X accuracy").
const FULL_CONTEXT_CHAR_LIMIT = 20000;

async function generateAnswer(
  query: string,
  allChunks: TextChunk[]
): Promise<{ answer: string; sources: SourceRef[] }> {
  const totalChars = allChunks.reduce((sum, c) => sum + c.text.length, 0);
  const useFullContext = totalChars <= FULL_CONTEXT_CHAR_LIMIT;

  const contextForLLM = useFullContext ? allChunks : retrieveRelevantChunks(query, allChunks);

  if (contextForLLM.length === 0) {
    return {
      answer:
        "I couldn't find relevant information in the uploaded documents to answer this question. Try rephrasing your question, or ensure the topic is covered in your documents.",
      sources: [],
    };
  }

  // Group once, by (document, page) — this exact grouping is what gets
  // numbered "[Source N]" in the LLM prompt AND what's shown as source card
  // [N] in the UI, so the two can never disagree.
  const groups = groupChunksByPage(contextForLLM);
  const sources = groupsToSources(groups);

  const answer = await askGroq(query, groups);
  return { answer, sources };
}

// ---------- Sub-components ----------

function DropZone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = (files: FileList | null) => {
    if (!files) return;
    const MAX = 5 * 1024 * 1024;
    const valid: File[] = [];
    let skipped = 0;
    for (const f of Array.from(files)) {
      const isPdf = f.type === "application/pdf" || f.name.endsWith(".pdf");
      const isDocx =
        f.type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        f.name.endsWith(".docx");
      if ((isPdf || isDocx) && f.size <= MAX) {
        valid.push(f);
      } else {
        skipped++;
      }
    }
    if (skipped > 0)
      toast.error(`${skipped} file(s) skipped — only PDF/DOCX under 5 MB accepted.`);
    if (valid.length) onFiles(valid);
  };

  return (
    <div
      className={`relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all duration-200
        ${dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-secondary/60"}
        ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.docx"
        className="hidden"
        onChange={(e) => handle(e.target.files)}
      />
      <Upload className="mx-auto mb-3 text-muted-foreground" size={24} strokeWidth={1.5} />
      <p className="text-sm font-medium text-foreground mb-1">Drop files here or click to browse</p>
      <p className="text-xs text-muted-foreground">PDF · DOCX · up to 5 MB each</p>
    </div>
  );
}

function DocBadge({ doc, onRemove }: { doc: UploadedDoc; onRemove: () => void }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border group hover:border-primary/30 transition-colors">
      <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
        <FileText size={15} className="text-primary" strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate leading-snug">{doc.name}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {formatSize(doc.size)} · {doc.pages}p · {doc.type.toUpperCase()} · {doc.chunks.length} passages
        </p>
      </div>
      <button
        onClick={onRemove}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all p-1 rounded"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function SourceCard({ source, index }: { source: SourceRef; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-secondary/50 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary transition-colors"
      >
        <BookOpen size={13} className="shrink-0 text-primary" strokeWidth={1.5} />
        <span className="text-xs font-medium text-foreground truncate flex-1">
          [{index + 1}] {source.docName}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">p. {source.page}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-border">
          <p className="text-xs text-muted-foreground leading-relaxed" style={{ fontFamily: "var(--font-mono)" }}>
            {source.excerpt}
          </p>
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-secondary"
    >
      {copied ? <Check size={12} className="text-primary" /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ChatMessage({ msg }: { msg: QAMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="shrink-0 w-7 h-7 rounded-full bg-primary flex items-center justify-center mt-0.5">
          <FileSearch size={13} className="text-primary-foreground" />
        </div>
      )}
      <div className={`max-w-[82%] flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`px-4 py-2.5 rounded-xl text-sm leading-relaxed
            ${isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap"
              : "bg-card border border-border text-foreground rounded-tl-sm"
            }`}
        >
          {isUser ? (
            msg.content
          ) : (
            <div className="prose-chat">
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
          )}
        </div>

        {!isUser && msg.sources && msg.sources.length > 0 && (
          <div className="w-full space-y-1.5">
            <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide px-1">
              Sources
            </p>
            {msg.sources.map((s, i) => (
              <SourceCard key={i} source={s} index={i} />
            ))}
          </div>
        )}

        {!isUser && (
          <div className="flex items-center gap-2 px-1">
            <CopyButton text={msg.content} />
            <span className="text-[10px] text-muted-foreground">
              {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Main App ----------

export default function App() {
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [processing, setProcessing] = useState<string | null>(null);
  const [messages, setMessages] = useState<QAMessage[]>([]);
  const [input, setInput] = useState("");
  const [answering, setAnswering] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, answering]);

  const allChunks = docs.flatMap((d) => d.chunks);

  const handleFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const isPdf = file.name.endsWith(".pdf") || file.type === "application/pdf";
      setProcessing(file.name);
      try {
        const { chunks, pages } = isPdf
          ? await extractPdfText(file)
          : await extractDocxText(file);

        const doc: UploadedDoc = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          size: file.size,
          type: isPdf ? "pdf" : "docx",
          pages,
          chunks,
          uploadedAt: new Date(),
        };
        setDocs((prev) => [...prev, doc]);
        toast.success(`"${file.name}" indexed — ${chunks.length} passages ready.`);
      } catch (err) {
        console.error(err);
        toast.error(`Could not parse "${file.name}". The file may be encrypted or corrupted.`);
      }
    }
    setProcessing(null);
  }, []);

  const removeDoc = (id: string) => {
    setDocs((prev) => prev.filter((d) => d.id !== id));
    toast("Document removed.");
  };

  const handleAsk = async () => {
    const q = input.trim();
    if (!q || answering) return;
    if (allChunks.length === 0) {
      toast.error("Upload at least one document first.");
      return;
    }

    const userMsg: QAMessage = {
      id: Date.now().toString(),
      role: "user",
      content: q,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = "42px";

    setAnswering(true);

    try {
      const { answer, sources } = await generateAnswer(q, allChunks);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: answer,
          sources,
          timestamp: new Date(),
        },
      ]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong while contacting Groq.";
      toast.error(message);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: `⚠️ ${message}`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setAnswering(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  const hasNoMessages = messages.length === 0;

  return (
    <div className="min-h-screen bg-background flex flex-col" style={{ fontFamily: "var(--font-sans, 'DM Sans', sans-serif)" }}>
      <Toaster richColors position="top-right" />

      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
              <FileSearch size={14} className="text-primary-foreground" strokeWidth={2} />
            </div>
            <span
              className="text-[17px] font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "'Fraunces', Georgia, serif" }}
            >
              DocQuery
            </span>
          </div>
          {docs.length > 0 && (
            <span className="text-xs text-muted-foreground bg-secondary px-2.5 py-1 rounded-full">
              {docs.length} doc{docs.length !== 1 ? "s" : ""} · {allChunks.length} passages indexed
            </span>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 max-w-6xl mx-auto w-full px-4 md:px-6 py-6 flex flex-col md:flex-row gap-5">

        {/* Left — documents */}
        <aside className="md:w-72 shrink-0 flex flex-col gap-4">
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">
              Documents
            </p>
            <DropZone onFiles={handleFiles} disabled={!!processing} />
          </div>

          {processing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
              <Loader2 size={14} className="animate-spin text-primary" />
              <span className="truncate text-xs">Parsing {processing}…</span>
            </div>
          )}

          {docs.length > 0 ? (
            <div className="space-y-2">
              {docs.map((doc) => (
                <DocBadge key={doc.id} doc={doc} onRemove={() => removeDoc(doc.id)} />
              ))}
              <button
                onClick={() => { setDocs([]); setMessages([]); toast("All documents cleared."); }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors pt-1 px-1"
              >
                <Trash2 size={12} />
                Clear all
              </button>
            </div>
          ) : !processing ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-center">
              <AlertCircle size={18} className="mx-auto mb-2 text-muted-foreground/40" strokeWidth={1.5} />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Upload PDFs or Word documents to start asking questions.
              </p>
            </div>
          ) : null}
        </aside>

        {/* Right — Q&A */}
        <main className="flex-1 flex flex-col bg-card rounded-xl border border-border overflow-hidden min-h-[500px]">

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {hasNoMessages && (
              <div className="h-full flex flex-col items-center justify-center text-center py-16 min-h-[300px]">
                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
                  <FileSearch size={24} className="text-primary" strokeWidth={1.5} />
                </div>
                <h3
                  className="text-xl font-semibold text-foreground mb-2"
                  style={{ fontFamily: "'Fraunces', Georgia, serif" }}
                >
                  Ask your documents
                </h3>
                <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
                  Upload PDF or Word files, then ask any question in natural language.
                  Answers are grounded exclusively in your documents.
                </p>
                {docs.length > 0 && (
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {[
                      "What is the main topic?",
                      "Summarize the key findings",
                      "What conclusions are drawn?",
                    ].map((s) => (
                      <button
                        key={s}
                        onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                        className="text-xs px-3 py-1.5 rounded-full border border-border bg-secondary hover:border-primary/40 text-foreground transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {messages.map((msg) => <ChatMessage key={msg.id} msg={msg} />)}

            {answering && (
              <div className="flex gap-3 justify-start">
                <div className="shrink-0 w-7 h-7 rounded-full bg-primary flex items-center justify-center mt-0.5">
                  <FileSearch size={13} className="text-primary-foreground" />
                </div>
                <div className="px-4 py-2.5 rounded-xl rounded-tl-sm bg-card border border-border">
                  <div className="flex gap-1 items-center h-5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border p-4 bg-background/40">
            <div className="flex gap-3 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "42px";
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  docs.length === 0
                    ? "Upload a document to begin…"
                    : "Ask a question… (Enter to send, Shift+Enter for new line)"
                }
                disabled={docs.length === 0 || answering}
                rows={1}
                className="flex-1 resize-none bg-input-background rounded-lg px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50 leading-relaxed"
                style={{ minHeight: "42px", maxHeight: "120px" }}
              />
              <button
                onClick={handleAsk}
                disabled={!input.trim() || docs.length === 0 || answering}
                className="shrink-0 w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
              >
                {answering ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 px-1">
              Answers reference only the content in your uploaded documents.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
