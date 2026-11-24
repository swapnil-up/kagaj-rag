import type { Env, ChatRequest, ChatResponse, Citation, VectorizeMetadata, ManifestIndex, ManifestDataset } from './types';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const STREAM_MODEL = '@cf/meta/llama-3.2-3b-instruct'; // Smaller model that actually streams
const DEFAULT_TOP_K = 10;
const RERANK_TOP_K = 10;
const MAX_CONTEXT_CHARS = 8000;
const CACHE_TTL = 86400; // 24 hours
const DAILY_NEURON_CAP = 9000; // Leave 1000 buffer under 10k free tier

const SYSTEM_PROMPT = `You are a research assistant for Kagaj — an open dataset of Nepali government documents.
You have access to parliament notices, verbatims, water schedules, crime bulletins, OAG audit reports, labour migration data, and .gov.np infrastructure data.

Answer questions accurately using ONLY the provided context. Cite sources inline like [1], [2].
If the context doesn't contain the answer, say so — don't hallucinate.
Connect insights across datasets when relevant (e.g., parliament discussion + OAG audit on same topic).
Be concise but thorough.`;

function buildContext(citations: Citation[]): string {
	let context = '';
	let totalChars = 0;
	citations.forEach((c, i) => {
		const datasetInfo = c.dataset_title ? ` — ${c.dataset_title}` : '';
		const verificationInfo = c.verification ? ` [Verified: ${c.verification}]` : '';
		const block = `[${i + 1}] ${c.dataset}/${c.type}${datasetInfo} (${c.date || 'n.d.'})${verificationInfo}\n${c.excerpt}\n\n`;
		if (totalChars + block.length > MAX_CONTEXT_CHARS) return;
		context += block;
		totalChars += block.length;
	});
	return context;
}

function buildPrompt(question: string, context: string, history: { role: string; content: string }[] = []): string {
	let prompt = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n${SYSTEM_PROMPT}<|eot_id|>`;
	
	for (const msg of history.slice(-6)) {
		prompt += `<|start_header_id|>${msg.role}<|end_header_id|>\n${msg.content}<|eot_id|>`;
	}
	
	prompt += `<|start_header_id|>user<|end_header_id|>\nContext:\n${context}\n\nQuestion: ${question}<|eot_id|>`;
	prompt += `<|start_header_id|>assistant<|end_header_id|>\n`;
	return prompt;
}

// Simple hash for cache keys
function hashKey(input: string): string {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) - hash) + input.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

function getCacheKey(question: string, datasetFilter?: string[], indexVersion?: string): string {
	const filterStr = datasetFilter?.sort().join(',') || 'all';
	const version = indexVersion || 'v1';
	return `chat:${hashKey(question)}:${hashKey(filterStr)}:${version}`;
}

function getNeuronKey(): string {
	const day = new Date().toISOString().split('T')[0];
	return `neurons:${day}`;
}

async function checkNeuronBudget(env: Env, estimated: number): Promise<boolean> {
	const key = getNeuronKey();
	const current = await env.CACHE.get(key);
	const used = current ? parseInt(current) : 0;
	return (used + estimated) < DAILY_NEURON_CAP;
}

async function incrementNeurons(env: Env, count: number): Promise<void> {
	const key = getNeuronKey();
	const current = await env.CACHE.get(key);
	const used = current ? parseInt(current) : 0;
	await env.CACHE.put(key, String(used + count), { expirationTtl: 86400 });
}

// Estimate neurons: embedding ~50, LLM ~1000-3000 depending on context
function estimateNeurons(citationCount: number, stream: boolean): number {
	const embedding = 50;
	const llmBase = stream ? 1500 : 2000; // Streaming uses more tokens
	const contextFactor = citationCount * 100;
	return embedding + llmBase + contextFactor;
}

export async function embedQuery(env: Env, query: string): Promise<number[]> {
	const resp = await env.AI.run(EMBEDDING_MODEL, { text: [query] });
	return (resp.data as number[][])[0];
}

export async function searchVectorize(env: Env, queryVector: number[], topK: number, datasetFilter?: string[]): Promise<VectorizeMetadata[]> {
	const fetchK = Math.min(topK * 5, 50);
	const results = await env.VECTORIZE.query(queryVector, { topK: fetchK, returnMetadata: true });
	const matches = results.matches as any[];
	
	let filtered = matches.map((m: any) => ({
		id: m.id,
		score: m.score,
		...m.metadata,
	})) as VectorizeMetadata[];
	
	if (datasetFilter?.length) {
		filtered = filtered.filter(m => datasetFilter.includes(m.dataset));
	}
	
	return filtered.slice(0, topK);
}

async function fetchManifest(env: Env): Promise<ManifestIndex | null> {
	const url = `https://api.github.com/repos/${env.KAGAJ_REPO_OWNER}/${env.KAGAJ_REPO_NAME}/contents/${env.KAGAJ_DATASETS_PATH}/index.json`;
	const resp = await fetch(url, { 
		headers: { 
			'Accept': 'application/vnd.github.v3+json', 
			'User-Agent': 'kagaj-rag-worker',
			...(env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${env.GITHUB_TOKEN}` } : {})
		} 
	});
	if (!resp.ok) return null;
	const fileInfo = await resp.json() as { download_url: string };
	const manifestResp = await fetch(fileInfo.download_url, { 
		headers: { 
			'Accept': 'application/vnd.github.v3+json', 
			'User-Agent': 'kagaj-rag-worker',
			...(env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${env.GITHUB_TOKEN}` } : {})
		} 
	});
	if (!manifestResp.ok) return null;
	return manifestResp.json() as Promise<ManifestIndex>;
}

function getDatasetManifest(manifest: ManifestIndex | null, datasetId: string): ManifestDataset | undefined {
	return manifest?.datasets.find(d => d.id === datasetId);
}

export async function rerankResults(env: Env, query: string, candidates: VectorizeMetadata[], topK: number): Promise<Citation[]> {
	if (candidates.length === 0) return [];
	
	const manifest = await fetchManifest(env);
	const ranked = candidates.slice(0, topK);
	
	return ranked.map((c, i) => {
		const datasetManifest = getDatasetManifest(manifest, c.dataset);
		return {
			doc_id: c.doc_id,
			dataset: c.dataset,
			type: c.type,
			title: c.title,
			date: c.date,
			url: c.url,
			excerpt: (c.text || '').slice(0, 500),
			score: c.score || 0,
			verification: datasetManifest?.verification?.method,
			source_url: datasetManifest?.sources[0]?.url,
			build_commit: datasetManifest?.freshness?.commit,
			dataset_title: datasetManifest?.title,
			dataset_description: datasetManifest?.description,
		};
	});
}

// In-flight request deduplication
const inflightRequests = new Map<string, Promise<ChatResponse>>();

export async function ragChat(env: Env, req: ChatRequest): Promise<ChatResponse> {
	const topK = req.top_k || DEFAULT_TOP_K;
	const indexVersion = req.dataset_filter?.sort().join(',') || 'all';
	const cacheKey = getCacheKey(req.question, req.dataset_filter, indexVersion);
	
	// Check cache first
	const cached = await env.CACHE.get(cacheKey);
	if (cached) {
		const hit = JSON.parse(cached);
		return { ...hit, cached: true };
	}
	
	// Check in-flight deduplication
	const inflightKey = `${cacheKey}:${req.stream || false}`;
	if (inflightRequests.has(inflightKey)) {
		return inflightRequests.get(inflightKey)!;
	}
	
	// Estimate and check neuron budget
	const queryVector = await embedQuery(env, req.question);
	const candidates = await searchVectorize(env, queryVector, topK * 2, req.dataset_filter);
	const estimatedNeurons = estimateNeurons(Math.min(candidates.length, RERANK_TOP_K), req.stream || false);
	
	const budgetOk = await checkNeuronBudget(env, estimatedNeurons);
	if (!budgetOk) {
		return {
			answer: 'Daily query limit reached. Please try again tomorrow.',
			citations: [],
			related_questions: [],
			rate_limited: true
		};
	}
	
	const promise = (async () => {
		try {
			const citations = await rerankResults(env, req.question, candidates, RERANK_TOP_K);
			const answer = await generateAnswer(env, req.question, citations, req.history || []);
			
			await incrementNeurons(env, estimatedNeurons);
			
			const result = { answer, citations, related_questions: [] };
			
			// Cache the result
			await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL });
			
			return result;
		} finally {
			inflightRequests.delete(inflightKey);
		}
	})();
	
	inflightRequests.set(inflightKey, promise);
	return promise;
}

export async function generateAnswer(env: Env, question: string, citations: Citation[], history: { role: string; content: string }[] = []): Promise<string> {
	const context = buildContext(citations);
	const prompt = buildPrompt(question, context, history);
	
	const resp = await env.AI.run(LLM_MODEL, {
		prompt,
		max_tokens: 1024,
		temperature: 0.3,
		stream: false,
	});
	
	return (resp.response || '').trim();
}

export async function* ragChatStream(env: Env, req: ChatRequest): AsyncGenerator<{ type: 'delta' | 'citations' | 'related' | 'done'; content?: string; citations?: Citation[]; related?: string[] }> {
	const topK = req.top_k || DEFAULT_TOP_K;
	const queryVector = await embedQuery(env, req.question);
	const candidates = await searchVectorize(env, queryVector, topK * 2, req.dataset_filter);
	const citations = await rerankResults(env, req.question, candidates, RERANK_TOP_K);
	const context = buildContext(citations);
	const prompt = buildPrompt(req.question, context, req.history || []);
	
	// Use smaller model for streaming that actually yields deltas
	const stream = await env.AI.run(STREAM_MODEL, {
		prompt,
		max_tokens: 1024,
		temperature: 0.3,
		stream: true,
	});
	
	for await (const chunk of stream as AsyncIterable<any>) {
		if (chunk.response) yield { type: 'delta', content: chunk.response };
	}
	
	yield { type: 'citations', citations };
	yield { type: 'done' };
}