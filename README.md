# Kagaj RAG

Research assistant for Nepali government datasets — chat with Parliament notices, verbatims, water schedules, crime bulletins, OAG audit reports, labour migration data, and .gov.np infrastructure data.

**Live:** https://kagaj-rag.swapnilupadhyay.com.np (or your custom domain)

---

## Architecture

```
┌─────────────────┐     GitHub API      ┌──────────────────┐
│  translation/   │ ──────────────────► │  kagaj-rag       │
│  (Kagaj repo)   │   datasets/*.json   │  Cloudflare      │
└─────────────────┘                     │  Worker          │
                                        ├──────────────────┤
                                        │  • Ingestion     │
                                        │  • Vectorize     │
                                        │  • RAG API       │
                                        └────────┬─────────┘
                                                 │
                                                 ▼
                                        ┌──────────────────┐
                                        │  Frontend        │
                                        │  (Vue 3 + Vite)  │
                                        └──────────────────┘
```

---

## Datasets Indexed

| Dataset | Path | Type | Description |
|---------|------|------|-------------|
| Parliament translations | `datasets/translations/` | `parliament` | 601 notices + verbatims (Nepali/English) |
| Labour migration | `datasets/labour-migration/` | `labour_migration` | 70K rows: district, destination, demographics |
| Water schedules | `datasets/water/` | `water_schedule` | KUKL branch schedules |
| Crime bulletins | `datasets/crime/` | `crime_bulletin` | Monthly/FY violent crime |
| OAG audits | `datasets/oag-audit/` | `oag_audit` | 721 local-level audit reports |
| Govweb infra | `datasets/govweb/` | `govweb_infra` | 2,837 .gov.np hostnames |

---

## Quick Start

### 1. Prerequisites

- Cloudflare account with Workers AI + Vectorize enabled
- `CLOUDFLARE_API_TOKEN` (Account-scoped, Workers + Vectorize + AI permissions)
- `CLOUDFLARE_ACCOUNT_ID`
- GitHub repo access (public repo works without token)

### 2. Create Vectorize Index

```bash
wrangler vectorize create kagaj-datasets --dimensions=1024 --metric=cosine
```

### 3. Create KV Namespace

```bash
wrangler kv namespace create "CACHE"
# Add the returned ID to wrangler.jsonc
```

### 4. Configure Secrets

```bash
wrangler secret put CLOUDFLARE_API_TOKEN  # if needed for ingestion
# Or set via Cloudflare Dashboard → Workers → kagaj-rag → Settings → Variables
```

### 5. Local Development

```bash
# Terminal 1: Start Worker
npm run dev

# Terminal 2: Build frontend (auto-watches)
cd frontend && npm run dev

# Trigger initial ingestion
npm run ingest
```

### 6. Deploy

```bash
# Build frontend first
npm run build:frontend

# Deploy Worker
npm run deploy
```

### 7. GitHub Actions

Add these secrets to your GitHub repo:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Workflows:
- **Deploy** — on push to main
- **Ingest** — daily at 03:00 UTC + manual trigger

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Frontend (Vue app) |
| `GET` | `/health` | Health check |
| `GET` | `/api/datasets` | List available datasets |
| `POST` | `/api/ingest` | Run full ingestion (GitHub → embed → Vectorize) |
| `GET` | `/api/ingest/stats` | Last ingestion stats |
| `POST` | `/api/chat` | RAG chat (streaming with `stream: true`) |

### Chat Request

```json
{
  "question": "What did parliament discuss about education in 2081?",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "dataset_filter": ["parliament", "oag_audit"],
  "top_k": 10,
  "stream": true
}
```

### Chat Response (Streaming SSE)

```
data: {"delta": "Based on the context..."}
data: {"delta": "..."}
data: {"done": true}
```

### Chat Response (Non-streaming)

```json
{
  "answer": "Based on parliament notices from 2081...",
  "citations": [
    {
      "doc_id": "notice-123",
      "dataset": "translations",
      "type": "parliament",
      "title": "Education Reform Bill",
      "date": "2081-03-15",
      "url": "https://hr.parliament.gov.np/...",
      "excerpt": "The bill proposes...",
      "score": 0.92
    }
  ],
  "related_questions": [
    "What was the OAG audit finding on education budgets?",
    "Which local levels have education infrastructure gaps?"
  ]
}
```

---

## RAG Pipeline Details

1. **Embedding**: BGE-m3 (1024-dim, multilingual, Nepali support)
2. **Retrieval**: Vectorize KNN (top 20)
3. **Reranking**: BGE-reranker-base (top 5)
4. **Generation**: Llama 3.3 70B FP8 Fast
5. **Context window**: ~8000 chars from top citations

---

## Custom Domain

In Cloudflare Dashboard:
1. Workers & Pages → kagaj-rag → Settings → Triggers
2. Add Custom Domain: `kagaj-rag.swapnilupadhyay.com.np`
3. DNS: CNAME `kagaj-rag` → `kagaj-rag.<account>.workers.dev`

---

## Project Structure

```
kagaj-rag/
├── wrangler.jsonc          # Worker config (bindings, vars)
├── package.json
├── src/
│   ├── index.ts            # Main Worker (routes, scheduled)
│   ├── types.ts            # TypeScript types
│   ├── ingest.ts           # GitHub → embed → Vectorize
│   └── rag.ts              # RAG pipeline (embed → search → rerank → LLM)
├── frontend/               # Vue 3 + Vite + Tailwind
│   ├── src/
│   │   ├── App.vue
│   │   ├── main.ts
│   │   ├── style.css
│   │   ├── components/ChatInterface.vue
│   │   └── types/index.ts
│   ├── index.html
│   ├── vite.config.ts
│   └── tailwind.config.js
├── public/                 # Built frontend (served by Worker assets)
└── .github/workflows/
    ├── deploy.yml
    └── ingest.yml
```

---

## Extending

### Add a new dataset

1. Add to `DATASET_CONFIG` in `src/ingest.ts`
2. Ensure JSON files are in `translation/datasets/<name>/`
3. Re-run ingestion

### Change models

Edit `src/rag.ts`:
- `EMBEDDING_MODEL` — e.g., `@cf/qwen/qwen3-embedding-0.6b`
- `RERANKER_MODEL` — e.g., `@cf/baai/bge-reranker-base`
- `LLM_MODEL` — e.g., `@cf/deepseek-ai/deepseek-v4-flash-0731`

### Add frontend features

- Dataset-specific views
- Document browser
- Export citations
- Multi-turn conversation persistence

---

## Costs (Estimated)

| Resource | Free Tier | Typical Monthly |
|----------|-----------|-----------------|
| Workers AI | 10k neurons/day | ~$0-5 |
| Vectorize | 5M vectors | ~$0-2 |
| Workers | 100k req/day | ~$0-1 |
| KV | 1 GB | ~$0 |

---

## License

MIT — Data from Kagaj (CC-BY-4.0 / government public records)