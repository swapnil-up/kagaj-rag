import type { Env, ChatRequest, IngestionStats, Citation } from './types';
import { runIngestion, getIngestionStats, getIngestionProgress, listDatasetFiles, getManifest } from './ingest';
import { ragChat, ragChatStream } from './rag';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body: string | null = null, status = 200): Response {
	return new Response(body, { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function sseResponse(stream: AsyncGenerator<{ type: 'delta' | 'citations' | 'related' | 'done'; content?: string; citations?: Citation[]; related?: string[] }>): Response {
	const encoder = new TextEncoder();
	const readable = new ReadableStream({
		async start(controller) {
			for await (const chunk of stream) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(readable, {
		headers: { ...CORS_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
	});
}

function checkIngestSecret(req: Request, env: Env): boolean {
	const secret = env.INGEST_SECRET;
	if (!secret) return false; // Ingestion disabled if no secret set
	const auth = req.headers.get('Authorization');
	return auth === `Bearer ${secret}`;
}

function rateLimitKey(req: Request): string {
	const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
	return `ratelimit:${ip}:${Math.floor(Date.now() / 60000)}`; // Per-minute buckets
}

async function checkRateLimit(env: Env, key: string, limit: number): Promise<boolean> {
	const current = await env.CACHE.get(key);
	const count = current ? parseInt(current) : 0;
	if (count >= limit) return false;
	await env.CACHE.put(key, String(count + 1), { expirationTtl: 60 });
	return true;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		
		if (req.method === 'OPTIONS') return corsResponse();
		
		// Rate limiting for chat endpoints
		if (url.pathname.startsWith('/api/chat') || url.pathname.startsWith('/api/debug/chat')) {
			const rlKey = rateLimitKey(req);
			const allowed = await checkRateLimit(env, rlKey, 30); // 30 req/min per IP
			if (!allowed) {
				return corsResponse(JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment.' }), 429);
			}
		}
		
		// Health check
		if (url.pathname === '/health') return corsResponse(JSON.stringify({ ok: true, service: 'kagaj-rag' }));
		
		// Ingestion endpoints (protected by secret)
		if (url.pathname === '/api/ingest' && req.method === 'POST') {
			if (!checkIngestSecret(req, env)) {
				return corsResponse(JSON.stringify({ error: 'Ingestion requires valid Authorization header' }), 401);
			}
			const body = await req.json().catch(() => ({})) as { limit?: number; offset?: number; force?: boolean };
			const stats = await runIngestion(env, { limit: body.limit ?? 20, offset: body.offset ?? 0, force: body.force ?? false });
			return corsResponse(JSON.stringify(stats));
		}
		if (url.pathname === '/api/ingest/stats') {
			if (!checkIngestSecret(req, env)) {
				return corsResponse(JSON.stringify({ error: 'Requires valid Authorization header' }), 401);
			}
			const stats = await getIngestionStats(env);
			const progress = await getIngestionProgress(env);
			return corsResponse(JSON.stringify({ ...stats, progress: progress || { message: 'No ingestion run yet' } }));
		}
		
		// Public dataset manifest (for frontend)
		if (url.pathname === '/api/datasets') {
			const manifest = await getManifest(env);
			if (!manifest) {
				return corsResponse(JSON.stringify({ error: 'Manifest not available' }), 503);
			}
			return corsResponse(JSON.stringify({ 
				datasets: manifest.datasets.map(d => ({
					id: d.id,
					title: d.title,
					description: d.description,
					status: d.status,
					grain: d.grain,
					coverage: d.coverage,
					sources: d.sources,
					verification: d.verification,
					license: d.license,
					tags: d.tags,
					freshness: d.freshness,
					artifact_count: d.artifacts.length,
				}))
			}));
		}
		
		// Debug endpoints (public but rate limited)
		if (url.pathname === '/api/debug/vectorize' && req.method === 'POST') {
			const { question, topK = 5, dataset_filter } = await req.json().catch(() => ({})) as { question: string; topK?: number; dataset_filter?: string[] };
			const { embedQuery, searchVectorize } = await import('./rag');
			const queryVector = await embedQuery(env, question || 'test');
			const results = await searchVectorize(env, queryVector, topK, dataset_filter);
			return corsResponse(JSON.stringify({ matches: results }));
		}
		if (url.pathname === '/api/debug/chat' && req.method === 'POST') {
			try {
				const body = await req.json() as ChatRequest;
				if (!body.question?.trim()) return corsResponse(JSON.stringify({ error: 'question required' }), 400);
				
				const { ragChat } = await import('./rag');
				const result = await ragChat(env, body);
				return corsResponse(JSON.stringify(result));
			} catch (err) {
				return corsResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Debug chat error' }), 400);
			}
		}
		if (url.pathname === '/api/debug/rerank' && req.method === 'POST') {
			try {
				const { question, topK = 10, dataset_filter } = await req.json().catch(() => ({})) as { question: string; topK?: number; dataset_filter?: string[] };
				const { embedQuery, searchVectorize, rerankResults } = await import('./rag');
				const queryVector = await embedQuery(env, question || 'test');
				const candidates = await searchVectorize(env, queryVector, 20, dataset_filter);
				const citations = await rerankResults(env, question, candidates, 10);
				return corsResponse(JSON.stringify({ candidates_count: candidates.length, citations }));
			} catch (err) {
				return corsResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Rerank error' }), 400);
			}
		}
		
		// Chat endpoints (public, rate limited)
		if (url.pathname === '/api/chat' && req.method === 'POST') {
			try {
				const body = await req.json() as ChatRequest;
				if (!body.question?.trim()) return corsResponse(JSON.stringify({ error: 'question required' }), 400);
				
				if (body.stream) {
					return sseResponse(ragChatStream(env, body));
				}
				
				const result = await ragChat(env, body);
				return corsResponse(JSON.stringify(result));
			} catch (err) {
				return corsResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid request' }), 400);
			}
		}
		
		// Frontend (served from assets)
		return env.ASSETS.fetch(req);
	},
	
	// Scheduled ingestion (daily at 03:00 UTC) - requires INGEST_SECRET to be set
	async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
		if (event.cron === '0 3 * * *') {
			if (!env.INGEST_SECRET) {
				console.log('Scheduled ingestion skipped: INGEST_SECRET not set');
				return;
			}
			console.log('Starting scheduled ingestion...');
			await runIngestion(env);
			console.log('Scheduled ingestion complete');
		}
	},
} satisfies ExportedHandler<Env>;