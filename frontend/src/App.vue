<script setup lang="ts">
import ChatInterface from './components/ChatInterface.vue';
import { onMounted } from 'vue';

onMounted(() => {
  document.title = 'Kagaj RAG — Nepali Government Data Assistant';
});
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <header class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
      <div class="max-w-4xl mx-auto px-4 py-4">
        <div class="flex items-center gap-3">
          <svg class="w-8 h-8 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div>
            <h1 class="text-xl font-semibold text-gray-900 dark:text-white">Kagaj RAG</h1>
            <p class="text-sm text-gray-500 dark:text-gray-400">Research assistant for Nepali government datasets</p>
          </div>
        </div>
      </div>
    </header>
    <main class="max-w-4xl mx-auto px-4 py-6">
      <ChatInterface />
    </main>
    <footer class="border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
      <div class="max-w-4xl mx-auto px-4 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>Datasets: Parliament • Water • Crime • OAG Audits • Labour Migration • Govweb Infrastructure</p>
        <p class="mt-1"><a href="https://github.com/swapnilupadhyay/translation" target="_blank" rel="noopener" class="underline hover:text-indigo-600">Kagaj on GitHub</a> • <a href="https://swapnilupadhyay.com.np" target="_blank" rel="noopener" class="underline hover:text-indigo-600">swapnilupadhyay.com.np</a></p>
      </div>
    </footer>
  </div>
</template>

<style>
/* Tailwind will be applied via build */
</style>