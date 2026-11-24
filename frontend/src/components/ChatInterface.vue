<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import type { Citation } from '@/types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  relatedQuestions?: string[];
  isStreaming?: boolean;
}

const messages = ref<Message[]>([]);
const input = ref('');
const isLoading = ref(false);
const error = ref<string | null>(null);
const datasetFilter = ref<string[]>([]);
const availableDatasets = ref<string[]>([]);
const messagesEndRef = ref<HTMLDivElement | null>(null);

const API_BASE = '/api';

async function fetchDatasets() {
  try {
    const resp = await fetch(`${API_BASE}/datasets`);
    const data = await resp.json();
    availableDatasets.value = data.datasets || [];
  } catch (e) {
    console.warn('Failed to fetch datasets', e);
  }
}

function scrollToBottom() {
  nextTick(() => {
    messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' });
  });
}

async function sendMessage() {
  const question = input.value.trim();
  if (!question || isLoading.value) return;
  
  error.value = null;
  const userMessage: Message = { role: 'user', content: question };
  messages.value.push(userMessage);
  input.value = '';
  isLoading.value = true;
  
  const assistantMessage: Message = { role: 'assistant', content: '', isStreaming: true };
  messages.value.push(assistantMessage);
  scrollToBottom();
  
  try {
    const resp = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: messages.value.slice(0, -2).map(m => ({ role: m.role, content: m.content })),
        dataset_filter: datasetFilter.value.length ? datasetFilter.value : undefined,
        stream: true,
      }),
    });
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    
    while (reader && !done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.delta) {
                assistantMessage.content += data.delta;
                scrollToBottom();
              }
              if (data.done) {
                assistantMessage.isStreaming = false;
                isLoading.value = false;
                scrollToBottom();
              }
            } catch (e) {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      }
    }
  } catch (err) {
    assistantMessage.content = `Error: ${err instanceof Error ? err.message : 'Failed to get response'}`;
    assistantMessage.isStreaming = false;
    isLoading.value = false;
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function toggleDataset(ds: string) {
  const idx = datasetFilter.value.indexOf(ds);
  if (idx >= 0) datasetFilter.value.splice(idx, 1);
  else datasetFilter.value.push(ds);
}

function clearChat() {
  messages.value = [];
}

onMounted(() => {
  fetchDatasets();
});

const suggestedQuestions = [
  'What did parliament discuss about education in 2081?',
  'Show me water supply schedules for Kathmandu branches',
  'What are the top crime categories in recent bulletins?',
  'Summarize OAG audit findings for local levels in Bagmati',
  'Which countries do Nepali migrants go to most?',
  'What .gov.np domains are unreachable?',
];

function useSuggestion(q: string) {
  input.value = q;
  sendMessage();
}
</script>

<template>
  <div class="space-y-6">
    <!-- Dataset Filter -->
    <div v-if="availableDatasets.length" class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Filter by dataset (optional)</label>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="ds in availableDatasets"
          :key="ds"
          @click="toggleDataset(ds)"
          :class="[
            'px-3 py-1 rounded-full text-sm transition-colors',
            datasetFilter.includes(ds)
              ? 'bg-indigo-600 text-white'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
          ]"
        >
          {{ ds }}
        </button>
        <button v-if="datasetFilter.length" @click="datasetFilter = []" class="px-3 py-1 rounded-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          Clear all
        </button>
      </div>
    </div>

    <!-- Chat Messages -->
    <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div class="max-h-[60vh] overflow-y-auto p-4 space-y-4" ref="scrollContainer">
        <div v-if="messages.length === 0" class="text-center text-gray-500 dark:text-gray-400 py-12">
          <svg class="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <p class="text-lg font-medium">Ask me about Nepali government data</p>
          <p class="text-sm mt-1">Parliament, water, crime, audits, migration, infrastructure...</p>
        </div>
        
        <div v-for="(msg, idx) in messages" :key="idx" class="flex gap-3" :class="{ 'flex-row-reverse': msg.role === 'user' }">
          <div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" :class="msg.role === 'user' ? 'bg-indigo-100 dark:bg-indigo-900' : 'bg-gray-100 dark:bg-gray-800'">
            <svg v-if="msg.role === 'user'" class="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <svg v-else class="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <div class="flex-1 min-w-0" :class="{ 'text-right': msg.role === 'user' }">
            <div class="prose prose-sm dark:prose-invert max-w-none" :class="{ 'text-right': msg.role === 'user' }">
              <p v-html="msg.content.replace(/\n/g, '<br>')" class="whitespace-pre-wrap"></p>
            </div>
            
            <div v-if="msg.citations && msg.citations.length" class="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
              <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Sources:</p>
              <div class="space-y-1">
                <div v-for="(cit, ci) in msg.citations" :key="ci" class="text-xs text-gray-600 dark:text-gray-400">
                  <span class="font-mono text-indigo-600 dark:text-indigo-400">[{{ ci + 1 }}]</span>
                  <span class="font-medium">{{ cit.dataset }}/{{ cit.type }}</span>
                  <span v-if="cit.title"> — {{ cit.title }}</span>
                  <span v-if="cit.date"> ({{ cit.date }})</span>
                  <a v-if="cit.url" :href="cit.url" target="_blank" rel="noopener" class="ml-1 underline hover:text-indigo-600">source</a>
                </div>
              </div>
            </div>
            
            <div v-if="msg.relatedQuestions && msg.relatedQuestions.length" class="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
              <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Follow-up questions:</p>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="(q, qi) in msg.relatedQuestions"
                  :key="qi"
                  @click="useSuggestion(q)"
                  class="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  {{ q }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div ref="messagesEndRef" />
      </div>
      
      <div class="border-t border-gray-100 dark:border-gray-800 p-4">
        <div class="flex gap-2">
          <textarea
            v-model="input"
            @keydown="handleKeyDown"
            :disabled="isLoading"
            placeholder="Ask about parliament, water schedules, crime data, OAG audits, migration, govweb..."
            class="flex-1 min-h-[48px] max-h-48 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            rows="1"
          ></textarea>
          <button
            @click="sendMessage"
            :disabled="isLoading || !input.trim()"
            class="px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <svg v-if="isLoading" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span v-else>Send</span>
          </button>
        </div>
        <div class="flex items-center justify-between mt-2">
          <div class="flex flex-wrap gap-1 text-xs text-gray-500 dark:text-gray-400">
            <span v-for="q in suggestedQuestions" :key="q" @click="useSuggestion(q)" class="underline hover:text-indigo-600 cursor-pointer px-2 py-1 rounded bg-gray-100 dark:bg-gray-800">
              {{ q }}
            </span>
          </div>
          <button @click="clearChat" class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Clear chat</button>
        </div>
      </div>
    </div>

    <div v-if="error" class="fixed bottom-4 right-4 bg-red-100 dark:bg-red-900 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-200 px-4 py-3 rounded-lg shadow-lg max-w-md">
      {{ error }}
      <button @click="error = null" class="ml-2 text-lg leading-none hover:opacity-70">&times;</button>
    </div>
  </div>
</template>