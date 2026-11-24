import type { Env, DatasetFile, ChunkMetadata, IngestionStats } from './types';

const GITHUB_API_BASE = 'https://api.github.com';
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const BATCH_SIZE = 100;

function ghHeaders(env: Env): Record<string, string> {
	const h: Record<string, string> = {
		'Accept': 'application/vnd.github.v3+json',
		'User-Agent': 'kagaj-rag-worker',
	};
	if (env.GITHUB_TOKEN) h['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
	return h;
}

const DATASET_CONFIG: Record<string, { type: string; titleField?: string; dateField?: string }> = {
	'translations': { type: 'parliament', titleField: 'title', dateField: 'date' },
	'labour-migration': { type: 'labour_migration', titleField: 'district', dateField: 'period' },
	'water': { type: 'water_schedule', titleField: 'branch', dateField: 'month' },
	'crime': { type: 'crime_bulletin', titleField: 'category', dateField: 'month' },
	'oag-audit': { type: 'oag_audit', titleField: 'local_level', dateField: 'fiscal_year' },
	'govweb': { type: 'govweb_infra', titleField: 'hostname', dateField: 'observed_at' },
};

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

function extractTextFromJSON(obj: any, dataset: string): string[] {
	const config = DATASET_CONFIG[dataset] || { type: dataset };
	const texts: string[] = [];

	if (Array.isArray(obj)) {
		obj.forEach((item, idx) => {
			const parts: string[] = [];
			if (config.titleField && item[config.titleField]) parts.push(`${config.titleField}: ${item[config.titleField]}`);
			if (config.dateField && item[config.dateField]) parts.push(`${config.dateField}: ${item[config.dateField]}`);
			Object.entries(item).forEach(([k, v]) => {
				if (k !== config.titleField && k !== config.dateField && v != null) {
					parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
				}
			});
			texts.push(parts.join(' | '));
		});
	} else if (typeof obj === 'object' && obj !== null) {
		const parts: string[] = [];
		if (config.titleField && obj[config.titleField]) parts.push(`${config.titleField}: ${obj[config.titleField]}`);
		if (config.dateField && obj[config.dateField]) parts.push(`${config.dateField}: ${obj[config.dateField]}`);
		Object.entries(obj).forEach(([k, v]) => {
			if (k !== config.titleField && k !== config.dateField && v != null) {
				parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
			}
		});
		texts.push(parts.join(' | '));
	}

	return texts;
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
		allFiles.push(...files.filter(f => f.type === 'file' && f.name.endsWith('.json')));
	}
	return allFiles;
}

export async function getFileContent(downloadUrl: string, env: Env): Promise<any> {
	const resp = await fetch(downloadUrl, { headers: ghHeaders(env) });
	if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);
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
	const resp = await env.AI.run('@cf/baai/bge-m3', { text: texts });
	return resp.data as number[][];
}

export async function upsertVectors(env: Env, vectors: { id: string; values: number[]; metadata: ChunkMetadata & { text: string } }[]): Promise<number> {
	let upserted = 0;
	for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
		const batch = vectors.slice(i, i + BATCH_SIZE);
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
		const files = await listDatasetFiles(env);
		stats.total_files = files.length;

		const batch = files.slice(offset, offset + limit);
		
		for (const file of batch) {
			try {
				const dataset = file.path.split('/')[1];
				const currentSha = await getFileSha(env, file.path);
				if (!force && currentSha && currentSha === file.sha) {
					stats.skipped++;
					continue;
				}

				const content = await getFileContent(file.download_url, env);
				const texts = extractTextFromJSON(content, dataset);

				for (let i = 0; i < texts.length; i++) {
					const chunks = chunkText(texts[i], CHUNK_SIZE, CHUNK_OVERLAP);
					stats.total_chunks += chunks.length;

					const embeddings = await embedTexts(env, chunks);
					const vectors = chunks.map((chunk, idx) => ({
						id: `${file.sha}-${i}-${idx}`,
						values: embeddings[idx],
						metadata: {
							doc_id: file.name.replace('.json', ''),
							dataset,
							type: DATASET_CONFIG[dataset]?.type || dataset,
							segment_idx: idx,
							total_segments: chunks.length,
							sha: file.sha,
							text: chunk,
						},
					}));

					await upsertVectors(env, vectors);
					stats.embedded += vectors.length;
				}

				await env.CACHE.put(`sha:${file.path}`, file.sha, { expirationTtl: 86400 });
			} catch (err) {
				stats.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Track progress for resuming
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