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

export interface ChatRequest {
	question: string;
	history?: { role: 'user' | 'assistant' | 'system'; content: string }[];
	dataset_filter?: string[];
	top_k?: number;
	stream?: boolean;
}

export interface ChatResponse {
	answer: string;
	citations: Citation[];
	related_questions?: string[];
}