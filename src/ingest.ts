import type { Env, DatasetFile, ChunkMetadata, IngestionStats, ManifestDataset, ManifestIndex } from './types';

const GITHUB_API_BASE = 'https://api.github.com';
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const BATCH_SIZE = 20;
const MAX_TOKENS_PER_CHUNK = 40000;
const MAX_TEXTS_PER_EMBED = 10;
const MAX_TEXTS_PER_FILE = 100;
const MAX_TEXTS_PER_CSV_FILE = 25;

function ghHeaders(env: Env): Record<string, string> {
	const h: Record<string, string> = {
		'Accept': 'application/vnd.github.v3+json',
		'User-Agent': 'kagaj-rag-worker',
	};
	if (env.GITHUB_TOKEN) h['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
	return h;
}

const CSV_GZ_FILES = [
	'reachability.csv.gz',
	'entities.csv.gz',
	'attribution.csv.gz',
	'roster.csv.gz',
	'sites.csv.gz',
	'operators.csv.gz',
	'entity_hosting.csv.gz',
	'hosting.csv.gz',
	'dns_mail.csv.gz',
	'globalping.csv.gz',
	'http_headers.csv.gz',
	'robots.csv.gz',
	'third_party_scripts.csv.gz',
	'tls.csv.gz',
];

function chunkText(text: string, size: number, overlap: number): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		const end = Math.min(start + size, text.length);
		chunks.push(text.slice(start, end));
		start += size - overlap;
	}
	return chunks;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3.5);
}

function chunkLargeText(text: string, maxTokens: number): string[] {
	const estimatedTokens = estimateTokens(text);
	if (estimatedTokens <= maxTokens) return [text];
	
	const chunks: string[] = [];
	const targetChars = Math.floor(maxTokens * 3.5);
	let start = 0;
	while (start < text.length) {
		const end = Math.min(start + targetChars, text.length);
		chunks.push(text.slice(start, end));
		start += targetChars - CHUNK_OVERLAP;
	}
	return chunks;
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

function extractTextFromJSON(obj: any, dataset: string, manifest: ManifestDataset | undefined): string[] {
	const type = manifest?.artifacts.find(a => a.role === 'primary')?.format || 'json';
	const texts: string[] = [];

	if (Array.isArray(obj)) {
		obj.forEach((item, idx) => {
			if (typeof item === 'object' && item !== null) {
				const parts: string[] = [];
				// Use manifest info if available
				if (manifest) {
					if (manifest.grain) parts.push(`grain: ${manifest.grain}`);
					if (manifest.coverage) parts.push(`coverage: ${manifest.coverage.start}–${manifest.coverage.end}`);
				}
				Object.entries(item).forEach(([k, v]) => {
					if (v != null) {
						parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
					}
				});
				if (parts.length > 0) texts.push(parts.join(' | '));
			} else if (item != null) {
				texts.push(String(item));
			}
		});
	} else if (typeof obj === 'object' && obj !== null) {
		const keys = Object.keys(obj);
		if (keys.length > 50) {
			keys.forEach(k => {
				const v = obj[k];
				if (v != null) {
					const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
					if (valStr.length > 50000) {
						const chunks = chunkLargeText(valStr, MAX_TOKENS_PER_CHUNK);
						chunks.forEach((chunk, idx) => {
							texts.push(`${k}[${idx}]: ${chunk}`);
						});
					} else {
						texts.push(`${k}: ${valStr}`);
					}
				}
			});
		} else {
			const parts: string[] = [];
			Object.entries(obj).forEach(([k, v]) => {
				if (v != null) {
					const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
					if (valStr.length > 50000) {
						const chunks = chunkLargeText(valStr, MAX_TOKENS_PER_CHUNK);
						chunks.forEach((chunk, idx) => {
							texts.push(`${k}[${idx}]: ${chunk}`);
						});
					} else {
						parts.push(`${k}: ${valStr}`);
					}
				}
			});
			if (parts.length > 0) texts.push(parts.join(' | '));
		}
	}

	return texts;
}

function extractTextFromCSV(rows: string[][], dataset: string, manifest: ManifestDataset | undefined): string[] {
	if (rows.length < 2) return [];
	const headers = rows[0];
	const texts: string[] = [];
	
	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		const parts: string[] = [];
		headers.forEach((h, idx) => {
			const val = row[idx];
			if (val != null && val !== '') {
				parts.push(`${h}: ${val}`);
			}
		});
		if (parts.length > 0) {
			texts.push(parts.join(' | '));
		}
	}
	return texts;
}

async function fetchManifest(env: Env): Promise<ManifestIndex | null> {
	const url = `${GITHUB_API_BASE}/repos/${env.KAGAJ_REPO_OWNER}/${env.KAGAJ_REPO_NAME}/contents/${env.KAGAJ_DATASETS_PATH}/index.json`;
	const resp = await fetch(url, { headers: ghHeaders(env) });
	if (!resp.ok) return null;
	const fileInfo = await resp.json() as { download_url: string };
	const manifestResp = await fetch(fileInfo.download_url, { headers: ghHeaders(env) });
	if (!manifestResp.ok) return null;
	return manifestResp.json() as Promise<ManifestIndex>;
}

function getDatasetManifest(manifest: ManifestIndex | null, dataset: string): ManifestDataset | undefined {
	return manifest?.datasets.find(d => d.id === dataset);
}

export async function listDatasetFiles(env: Env): Promise<DatasetFile[]> {
	const { KAGAJ_REPO_OWNER, KAGAJ_REPO_NAME, KAGAJ_DATASETS_PATH } = env;
	const url = `${GITHUB_API_BASE}/repos/${KAGAJ_REPO_OWNER}/${KAGAJ_REPO_NAME}/contents/${KAGAJ_DATASETS_PATH}`;
	const resp = await fetch(url, { headers: ghHeaders(env) });
	if (!resp.ok) throw new Error(`GitHub API error: ${resp.status} ${await resp.text()}`);
	const items = await resp.json() as DatasetFile[];
	const datasetDirs = items.filter(i => i.type === 'dir');
	const allFiles: DatasetFile[] = [];

	for (const dir of datasetDirs) {
		const filesUrl = `${GITHUB_API_BASE}/repos/${KAGAJ_REPO_OWNER}/${KAGAJ_REPO_NAME}/contents/${dir.path}`;
		const filesResp = await fetch(filesUrl, { headers: ghHeaders(env) });
		if (!filesResp.ok) continue;
		const files = await filesResp.json() as DatasetFile[];
		allFiles.push(...files.filter(f => f.type === 'file' && (f.name.endsWith('.json') || f.name.endsWith('.csv.gz'))));
	}
	return allFiles;
}

export async function getFileContent(downloadUrl: string, env: Env): Promise<any> {
	const resp = await fetch(downloadUrl, { headers: ghHeaders(env) });
	if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);
	
	if (downloadUrl.endsWith('.csv.gz')) {
		return parseCSVGZ(downloadUrl, env);
	}
	return resp.json();
}

export async function getFileSha(env: Env, path: string): Promise<string | null> {
	const cacheKey = `sha:${path}`;
	const cached = await env.CACHE.get(cacheKey);
	if (cached) return cached;
	const url = `${GITHUB_API_BASE}/repos/${env.KAGAJ_REPO_OWNER}/${env.KAGAJ_REPO_NAME}/contents/${path}`;
	const resp = await fetch(url, { headers: ghHeaders(env) });
	if (!resp.ok) return null;
	const data = await resp.json() as { sha: string };
	await env.CACHE.put(cacheKey, data.sha, { expirationTtl: 86400 });
	return data.sha;
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
	const allEmbeddings: number[][] = [];
	for (let i = 0; i < texts.length; i += 10) {
		const batch = texts.slice(i, i + 10);
		const resp = await env.AI.run('@cf/baai/bge-m3', { text: batch });
		allEmbeddings.push(...(resp.data as number[][]));
	}
	return allEmbeddings;
}

export async function upsertVectors(env: Env, vectors: { id: string; values: number[]; metadata: ChunkMetadata & { text: string } }[]): Promise<number> {
	let upserted = 0;
	for (let i = 0; i < vectors.length; i += 20) {
		const batch = vectors.slice(i, i + 20);
		await env.VECTORIZE.upsert(batch.map(v => ({ id: v.id, values: v.values, metadata: v.metadata })));
		upserted += batch.length;
	}
	return upserted;
}

export async function runIngestion(env: Env, options: { limit?: number; offset?: number; force?: boolean } = {}): Promise<IngestionStats> {
	const { limit = 20, offset = 0, force = false } = options;
	const stats: IngestionStats = {
		total_files: 0,
		total_chunks: 0,
		embedded: 0,
		skipped: 0,
		errors: [],
		completed_at: new Date().toISOString(),
	};

	try {
		const manifest = await fetchManifest(env);
		const files = await listDatasetFiles(env);
		stats.total_files = files.length;

		const batch = files.slice(offset, offset + limit);
		
		for (const file of batch) {
			try {
				const dataset = file.path.split('/')[1];
				const datasetManifest = getDatasetManifest(manifest, dataset);
				const currentSha = await getFileSha(env, file.path);
				if (!force && currentSha && currentSha === file.sha) {
					stats.skipped++;
					continue;
				}

				const content = await getFileContent(file.download_url, env);
				
				let texts: string[] = [];
				
				if (file.name.endsWith('.csv.gz')) {
					texts = extractTextFromCSV(content as string[][], dataset, datasetManifest);
				} else {
					texts = extractTextFromJSON(content, dataset, datasetManifest);
				}

				const maxTexts = file.name.endsWith('.csv.gz') ? MAX_TEXTS_PER_CSV_FILE : MAX_TEXTS_PER_FILE;
				if (texts.length > maxTexts) {
					texts = texts.slice(0, maxTexts);
					stats.errors.push(`${file.path}: Truncated to ${maxTexts} texts`);
				}

				for (let i = 0; i < texts.length; i++) {
					const largeChunks = chunkLargeText(texts[i], MAX_TOKENS_PER_CHUNK);
					
					for (const largeChunk of largeChunks) {
						const chunks = chunkText(largeChunk, CHUNK_SIZE, CHUNK_OVERLAP);
						stats.total_chunks += chunks.length;

						const embeddings = await embedTexts(env, chunks);
						const vectors = chunks.map((chunk, idx) => ({
							id: `${file.sha}-${i}-${idx}`,
							values: embeddings[idx],
							metadata: {
								doc_id: file.name.replace(/\.(json|csv\.gz)$/, ''),
								dataset,
								type: datasetManifest?.id || 'unknown',
								segment_idx: idx,
								total_segments: chunks.length,
								sha: file.sha,
								text: chunk,
							},
						}));

						await upsertVectors(env, vectors);
						stats.embedded += vectors.length;
					}
				}

				await env.CACHE.put(`sha:${file.path}`, file.sha, { expirationTtl: 86400 });
			} catch (err) {
				stats.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		await env.CACHE.put('ingestion:progress', JSON.stringify({ 
			processed: offset + batch.length, 
			total: files.length,
			last_run: new Date().toISOString()
		}), { expirationTtl: 86400 });
		
	} catch (err) {
		stats.errors.push(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
	}

	await env.CACHE.put('ingestion:stats', JSON.stringify(stats), { expirationTtl: 86400 });
	return stats;
}

export async function getIngestionProgress(env: Env): Promise<{ processed: number; total: number; last_run: string } | null> {
	const cached = await env.CACHE.get('ingestion:progress');
	return cached ? JSON.parse(cached) : null;
}

export async function getIngestionStats(env: Env): Promise<IngestionStats | null> {
	const cached = await env.CACHE.get('ingestion:stats');
	return cached ? JSON.parse(cached) : null;
}

export async function getManifest(env: Env): Promise<ManifestIndex | null> {
	return fetchManifest(env);
}