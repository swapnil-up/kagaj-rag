import type { Env } from '../types';

interface CSVProcessRequest {
	file_path: string;
	dataset: string;
	batch_size?: number;
	start_row?: number;
}

interface CSVProcessResponse {
	success: boolean;
	rows_processed: number;
	rows_total: number;
	next_start_row?: number;
	error?: string;
}

const GITHUB_API_BASE = 'https://api.github.com';
const BATCH_EMBED_SIZE = 50;
const MAX_TOKENS_PER_CHUNK = 40000;

function ghHeaders(env: Env): Record<string, string> {
	const h: Record<string, string> = {
		'Accept': 'application/vnd.github.v3+json',
		'User-Agent': 'kagaj-csv-worker',
	};
	if (env.GITHUB_TOKEN) h['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
	return h;
}

async function parseCSVGZ(url: string, env: Env): Promise<string[][]> {
	const resp = await fetch(url, { headers: ghHeaders(env) });
	if (!resp.ok) throw new Error(`Failed to download CSV: ${resp.status}`);
	
	const compressed = await resp.arrayBuffer();
	const decompressed = await new Response(compressed, {
		headers: { 'Content-Encoding': 'gzip' }
	}).arrayBuffer();
	
	const text = new TextDecoder().decode(decompressed);
	const lines = text.trim().split('\n');
	return lines.map(line => {
		const result: string[] = [];
		let current = '';
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (char === '"') {
				inQuotes = !inQuotes;
			} else if (char === ',' && !inQuotes) {
				result.push(current);
				current = '';
			} else {
				current += char;
			}
		}
		result.push(current);
		return result;
	});
}

async function embedBatch(env: Env, texts: string[]): Promise<number[][]> {
	const allEmbeddings: number[][] = [];
	for (let i = 0; i < texts.length; i += BATCH_EMBED_SIZE) {
		const batch = texts.slice(i, i + BATCH_EMBED_SIZE);
		const resp = await env.AI.run('@cf/baai/bge-m3', { text: batch });
		allEmbeddings.push(...(resp.data as number[][]));
	}
	return allEmbeddings;
}

async function upsertVectors(env: Env, vectors: { id: string; values: number[]; metadata: any }[]): Promise<number> {
	let upserted = 0;
	for (let i = 0; i < vectors.length; i += 20) {
		const batch = vectors.slice(i, i + 20);
		await env.VECTORIZE.upsert(batch.map(v => ({ id: v.id, values: v.values, metadata: v.metadata })));
		upserted += batch.length;
	}
	return upserted;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		
		if (req.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type',
				}
			});
		}
		
		if (url.pathname === '/health') {
			return new Response(JSON.stringify({ ok: true, service: 'kagaj-csv-processor' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		if (url.pathname === '/api/process-csv' && req.method === 'POST') {
			try {
				const body = await req.json() as CSVProcessRequest;
				const { file_path, dataset, batch_size = 50, start_row = 0 } = body;
				
				if (!file_path || !dataset) {
					return new Response(JSON.stringify({ error: 'file_path and dataset required' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' }
					});
				}
				
				// Download and parse CSV
				const url = `${GITHUB_API_BASE}/repos/${env.KAGAJ_REPO_OWNER}/${env.KAGAJ_REPO_NAME}/contents/${file_path}`;
				const fileResp = await fetch(url, { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'kagaj-csv-worker' } });
				if (!fileResp.ok) throw new Error(`Failed to get file info: ${fileResp.status}`);
				const fileInfo = await fileResp.json() as { download_url: string };
				
				const csvData = await parseCSVGZ(fileInfo.download_url, env);
				if (csvData.length < 2) {
					return new Response(JSON.stringify({ success: true, rows_processed: 0, rows_total: 0 }), {
						headers: { 'Content-Type': 'application/json' }
					});
				}
				
				const headers = csvData[0];
				const rows = csvData.slice(1);
				const totalRows = rows.length;
				
				if (start_row >= totalRows) {
					return new Response(JSON.stringify({ 
						success: true, 
						rows_processed: 0, 
						rows_total: totalRows 
					}), {
						headers: { 'Content-Type': 'application/json' }
					});
				}
				
				const endRow = Math.min(start_row + batch_size, totalRows);
				const batchRows = rows.slice(start_row, endRow);
				
				// Convert rows to text
				const texts = batchRows.map(row => {
					const parts: string[] = [];
					headers.forEach((h, idx) => {
						const val = row[idx];
						if (val != null && val !== '') {
							parts.push(`${h}: ${val}`);
						}
					});
					return parts.join(' | ');
				}).filter(t => t.length > 0);
				
				if (texts.length === 0) {
					return new Response(JSON.stringify({ 
						success: true, 
						rows_processed: endRow - start_row, 
						rows_total: totalRows,
						next_start_row: endRow < totalRows ? endRow : undefined
					}), {
						headers: { 'Content-Type': 'application/json' }
					});
				}
				
				// Embed using batch API
				const embeddings = await embedBatch(env, texts);
				
				// Prepare vectors - match main worker's expected metadata format
				const baseDocId = file_path.split('/').pop()?.replace('.csv.gz', '') || 'unknown';
				const vectors = texts.map((text, idx) => ({
					id: `${file_path}-${start_row + idx}`,
					values: embeddings[idx],
					metadata: {
						doc_id: `${baseDocId}-${start_row + idx}`,
						dataset,
						type: 'govweb_infra',
						title: `Row ${start_row + idx}`,
						url: `https://github.com/${env.KAGAJ_REPO_OWNER}/${env.KAGAJ_REPO_NAME}/blob/main/${file_path}#L${start_row + idx + 2}`,
						text: text,
					}
				})
				
				await upsertVectors(env, vectors);
				
				return new Response(JSON.stringify({
					success: true,
					rows_processed: endRow - start_row,
					rows_total: totalRows,
					next_start_row: endRow < totalRows ? endRow : undefined
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
				
			} catch (err) {
				return new Response(JSON.stringify({ 
					success: false, 
					error: err instanceof Error ? err.message : String(err) 
				}), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}
		
		return new Response('Not found', { status: 404 });
	}
};