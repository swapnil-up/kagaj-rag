import type { Env, ChatRequest, ChatResponse, Citation, VectorizeMetadata } from './types';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const RERANKER_MODEL = '@cf/baai/bge-reranker-base';
const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_TOP_K = 10;
const RERANK_TOP_K = 10;
const MAX_CONTEXT_CHARS = 8000;

const SYSTEM_PROMPT = `You are a research assistant for Kagaj — an open dataset of Nepali government documents.
You have access to parliament notices, verbatims, water schedules, crime bulletins, OAG audit reports, labour migration data, and .gov.np infrastructure data.

Answer questions accurately using ONLY the provided context. Cite sources inline like [1], [2].
If the context doesn't contain the answer, say so — don't hallucinate.
Connect insights across datasets when relevant (e.g., parliament discussion + OAG audit on same topic).
Be concise but thorough. Suggest follow-up questions at the end.`;

function buildContext(citations: Citation[]): string {
	let context = '';
	let totalChars = 0;
	citations.forEach((c, i) => {
		const block = `[${i + 1}] ${c.dataset}/${c.type}: ${c.title || c.doc_id} (${c.date || 'n.d.'})\n${c.excerpt}\n\n`;
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

export async function embedQuery(env: Env, query: string): Promise<number[]> {
	const resp = await env.AI.run(EMBEDDING_MODEL, { text: [query] });
	return (resp.data as number[][])[0];
}

export async function searchVectorize(env: Env, queryVector: number[], topK: number, datasetFilter?: string[]): Promise<VectorizeMetadata[]> {
	// Fetch more results than needed, then filter in JavaScript
	// This avoids issues with Vectorize filter syntax
	// Vectorize max topK with returnMetadata=true is 50
	const fetchK = datasetFilter?.length ? Math.min(topK * 5, 50) : topK;
	const results = await env.VECTORIZE.query(queryVector, { topK: fetchK, returnMetadata: true });
	const matches = results.matches as any[];
	
	// Filter in JavaScript
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

export async function rerankResults(env: Env, query: string, candidates: VectorizeMetadata[], topK: number): Promise<Citation[]> {
	if (candidates.length === 0) return [];
	
	// Skip reranker for now - use vector similarity scores
	const ranked = candidates
		.slice(0, topK);
	
	return ranked.map((c, i) => ({
		doc_id: c.doc_id,
		dataset: c.dataset,
		type: c.type,
		title: c.title,
		date: c.date,
		url: c.url,
		excerpt: (c.text || '').slice(0, 500),
		score: 1.0 - (i * 0.1),
	}));
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

export async function generateRelatedQuestions(env: Env, question: string, citations: Citation[]): Promise<string[]> {
	const context = buildContext(citations.slice(0, 3));
	const prompt = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>
Given the question and context, suggest 3 follow-up questions a researcher might ask. Return only a JSON array of strings.
<|eot_id|><|start_header_id|>user<|end_header_id|>
Question: ${question}
Context: ${context}
<|eot_id|><|start_header_id|>assistant<|end_header_id|>`;
	
	try {
		const resp = await env.AI.run(LLM_MODEL, { prompt, max_tokens: 200, temperature: 0.5 });
		const text = (resp.response || '').trim();
		const match = text.match(/\[.*\]/s);
		return match ? JSON.parse(match[0]) : [];
	} catch {
		return [];
	}
}

export async function ragChat(env: Env, req: ChatRequest): Promise<ChatResponse> {
	const topK = req.top_k || DEFAULT_TOP_K;
	const queryVector = await embedQuery(env, req.question);
	const candidates = await searchVectorize(env, queryVector, topK * 2, req.dataset_filter);
	const citations = await rerankResults(env, req.question, candidates, RERANK_TOP_K);
	const answer = await generateAnswer(env, req.question, citations, req.history || []);
	const related_questions = await generateRelatedQuestions(env, req.question, citations);
	
	return { answer, citations, related_questions };
}

export async function* ragChatStream(env: Env, req: ChatRequest): AsyncGenerator<{ type: 'delta' | 'citations' | 'related' | 'done'; content?: string; citations?: Citation[]; related?: string[] }> {
	const topK = req.top_k || DEFAULT_TOP_K;
	const queryVector = await embedQuery(env, req.question);
	const candidates = await searchVectorize(env, queryVector, topK * 2, req.dataset_filter);
	const citations = await rerankResults(env, req.question, candidates, RERANK_TOP_K);
	const context = buildContext(citations);
	const prompt = buildPrompt(req.question, context, req.history || []);
	
	const stream = await env.AI.run(LLM_MODEL, {
		prompt,
		max_tokens: 1024,
		temperature: 0.3,
		stream: true,
	});
	
	for await (const chunk of stream as AsyncIterable<any>) {
		if (chunk.response) yield { type: 'delta', content: chunk.response };
	}
	
	yield { type: 'citations', citations };
	
	if (citations.length > 0) {
		const related = await generateRelatedQuestions(env, req.question, citations);
		if (related.length > 0) {
			yield { type: 'related', related };
		}
	}
	
	yield { type: 'done' };
}