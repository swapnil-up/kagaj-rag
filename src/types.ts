export interface Env {
	AI: Ai;
	VECTORIZE: VectorizeIndex;
	CACHE: KVNamespace;
	KAGAJ_REPO_OWNER: string;
	KAGAJ_REPO_NAME: string;
	KAGAJ_DATASETS_PATH: string;
	GITHUB_TOKEN?: string;
}

export interface DatasetFile {
	name: string;
	path: string;
	sha: string;
	size: number;
	url: string;
	download_url: string;
	type: 'file';
}

export interface ChunkMetadata {
	doc_id: string;
	dataset: string;
	type: string;
	title?: string;
	date?: string;
	url?: string;
	segment_idx: number;
	total_segments: number;
	sha: string;
}

export interface VectorizeMetadata extends ChunkMetadata {
	text: string;
}

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface ChatRequest {
	question: string;
	history?: ChatMessage[];
	dataset_filter?: string[];
	top_k?: number;
}

export interface Citation {
	doc_id: string;
	dataset: string;
	type: string;
	title?: string;
	date?: string;
	url?: string;
	excerpt: string;
	score: number;
	verification?: string;
	source_url?: string;
	build_commit?: string;
	dataset_title?: string;
	dataset_description?: string;
}

export interface ManifestDataset {
	id: string;
	title: string;
	description: string;
	status: string;
	grain: string;
	coverage: { start: string; end: string; note?: string };
	sources: Array<{ name: string; url: string }>;
	verification: { status: string; method: string; report?: string };
	pipeline: { package: string; cli: string; plan?: string };
	license: { code: string; data: string };
	tags: string[];
	notes: string[];
	docs: string[];
	inventories: string[];
	freshness: { fingerprints: string[]; commit: string };
	artifacts: Array<{ path: string; role: string; format: string; bytes: number; columns?: string[]; sha256: string; description?: string }>;
}

export interface ManifestIndex {
	schema_version: string;
	datasets: ManifestDataset[];
}

export interface ChatResponse {
	answer: string;
	citations: Citation[];
	related_questions?: string[];
}

export interface IngestionStats {
	total_files: number;
	total_chunks: number;
	embedded: number;
	skipped: number;
	errors: string[];
	completed_at: string;
}