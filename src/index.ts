import type { Env, ChatRequest, IngestionStats, Citation } from './types';
import { runIngestion, getIngestionStats, getIngestionProgress, listDatasetFiles } from './ingest';
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

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		
		if (req.method === 'OPTIONS') return corsResponse();
		
		// Health check
		if (url.pathname === '/health') return corsResponse(JSON.stringify({ ok: true, service: 'kagaj-rag' }));
		
		// Ingestion endpoints
		if (url.pathname === '/api/ingest' && req.method === 'POST') {
			const body = await req.json().catch(() => ({})) as { limit?: number; offset?: number; force?: boolean };
			const stats = await runIngestion(env, { limit: body.limit ?? 20, offset: body.offset ?? 0, force: body.force ?? false });
			return corsResponse(JSON.stringify(stats));
		}
		if (url.pathname === '/api/ingest/stats') {
			const stats = await getIngestionStats(env);
			const progress = await getIngestionProgress(env);
			return corsResponse(JSON.stringify({ ...stats, progress: progress || { message: 'No ingestion run yet' } }));
		}
		if (url.pathname === '/api/datasets') {
			const files = await listDatasetFiles(env);
			const datasets = [...new Set(files.map(f => f.path.split('/')[1]))];
			return corsResponse(JSON.stringify({ datasets, file_count: files.length }));
		}
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
		
		// Chat endpoints
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
	
	// Scheduled ingestion (daily at 03:00 UTC)
	async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
		if (event.cron === '0 3 * * *') {
			console.log('Starting scheduled ingestion...');
			await runIngestion(env);
			console.log('Scheduled ingestion complete');
		}
	},
} satisfies ExportedHandler<Env>;