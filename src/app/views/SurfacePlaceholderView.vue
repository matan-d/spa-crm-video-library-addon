<script setup lang="ts">
// A deliberate placeholder: it names the surface and when it lands, so a
// reviewer clicking around sees a plan rather than a broken page. It reads
// nothing, because a placeholder that half-renders real data teaches the wrong
// lesson about what is finished.
defineProps<{ title: string; note: string }>()
</script>

<template>
  <section class="placeholder">
    <h1>{{ title }}</h1>
    <p class="note">
      {{ note }}
    </p>
    <p class="badge mono">
      not built yet
    </p>
  </section>
</template>

<style scoped>
.placeholder {
  max-width: 46rem;
  padding: var(--space-6) var(--space-4);
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  letter-spacing: -0.01em;
  margin: 0 0 var(--space-2);
}

.note {
  color: var(--muted);
  max-width: 62ch;
  margin: 0 0 var(--space-4);
}

.badge {
  display: inline-block;
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-2);
  margin: 0;
}
</style>
