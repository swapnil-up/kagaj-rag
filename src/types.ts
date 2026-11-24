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