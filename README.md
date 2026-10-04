# DocQuery — Document Q&A Assistant

DocQuery lets you upload PDF or Word documents, ask questions in plain language, and get answers grounded **only** in your documents — each with the exact source passages so you can verify the answer instead of trusting it blindly.

**Live demo:** https://qa-assisstant-v2.vercel.app

> Prototype built for a class assignment. It runs entirely in the browser: no backend, no database, no accounts.

---

## Features

- **Multi-file upload** — drag and drop or click to browse; each file appears as a removable card.
- **PDF and DOCX support** — PDFs parsed with PDF.js, DOCX with a lightweight in-browser extractor.
- **File size limit** — files over 5 MB are rejected with a toast message.
- **Natural-language questions** — free-text chat with suggested starter questions.
- **Grounded answers** — the model is instructed to answer only from your documents and to say so when the answer isn't there.
- **Source citations** — numbered, expandable source cards (document, page, excerpt) that match the inline `[Source N]` citations.
- **One-click copy** of any answer.
- **Adaptive retrieval** — small document sets are sent in full; larger ones are narrowed with keyword-overlap scoring.
- **Resilient API calls** — automatic retry with backoff on rate limits (429) and overloads (503), with a fallback model.
- **Markdown-rendered answers** and toast notifications for upload and parsing errors.

## How it works

1. **Upload** — files are validated (type and size), parsed to plain text, and split into page-tagged passages held in browser memory.
2. **Ask** — if the total text is small (about 20,000 characters or less), every passage is sent as context. Otherwise the app ranks passages by keyword overlap and sends the top matches.
3. **Prompt** — passages are grouped by document and page and numbered as `[Source 1]`, `[Source 2]`, and so on. The same grouping drives the source cards in the UI, so citations and cards always match.
4. **Answer** — the prompt is sent to Groq's OpenAI-compatible chat completions endpoint, and the answer is rendered with its sources.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript, built with Vite |
| Styling / UI | Tailwind CSS v4, shadcn/ui (Radix UI), lucide-react, sonner |
| PDF parsing | PDF.js (loaded from CDN) |
| DOCX parsing | Custom in-browser extractor |
| Answer generation | [Groq API](https://console.groq.com) (OpenAI-compatible chat completions) |
| Hosting | Vercel (static site) |

## Getting started

### Prerequisites

- Node.js 18 or later
- A free Groq API key from https://console.groq.com/keys

### Run locally

```bash
git clone https://github.com/safiamussaratt/qa_assistant.git
cd qa_assistant
npm i
```

Create a `.env` file in the project root (next to `package.json`):

```bash
cp .env.example .env
```

Then open `.env` and paste in your key:

```
VITE_GROQ_API_KEY=your_key_here
```

Start the dev server:

```bash
npm run dev
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `VITE_GROQ_API_KEY` | Yes | Your Groq API key. |
| `VITE_GROQ_MODEL` | No | Primary Groq model ID. Falls back to the default set in `App.tsx`. |

Vite reads environment variables at build time, so restart the dev server after changing `.env`.

## Deploying to Vercel

1. Import the repository into Vercel (Vite is auto-detected).
2. Under **Settings → Environment Variables**, add `VITE_GROQ_API_KEY` (and optionally `VITE_GROQ_MODEL`).
3. Deploy. Pushes to `main` redeploy automatically. After changing an environment variable, trigger a redeploy so the new value is built in.

## Models

Groq retires models from time to time. If you see an error like `The model ... does not exist or you do not have access to it` (404), the model has likely been deprecated. Check [Groq's deprecations page](https://console.groq.com/docs/deprecations) for the recommended replacement and update the model IDs in `askGroq` in `App.tsx`, or set `VITE_GROQ_MODEL`.

## Known limitations

- **API key exposure** — the key is bundled into the client at build time, so anyone inspecting the site's JS or network traffic can see it. This is acceptable for a class prototype. A production version should route requests through a small server or proxy so the key stays server-side. Use a free-tier key you can rotate.
- **DOCX parsing is best-effort** — the extractor works on the raw document package rather than a full parsing library, so heavily styled, table-heavy, or unusually structured Word files may extract poorly. PDFs are more reliable.
- **Page count isn't enforced** — only the 5 MB limit is checked. The app is designed for documents of roughly 5–10 pages.
- **No persistence** — refreshing the page clears uploaded documents and chat history.
- **Keyword retrieval** — for large document sets, passages that don't share words with the question can be missed.

## Contributing / feedback

This is a prototype, but issues and suggestions are welcome via the [Issues](https://github.com/safiamussaratt/qa_assistant/issues) tab.

## Acknowledgements

Originally scaffolded from a [Figma design](https://www.figma.com/design/apA9hVGzPBDKCZ2O9vFkF6/Document-Q-A-Assistant-Prototype). See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for third-party credits.
