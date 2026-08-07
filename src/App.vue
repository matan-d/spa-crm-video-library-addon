<script setup lang="ts">
// Placeholder shell. The three role surfaces land once the scoped repository
// exists (F3), because no component in this app talks to storage directly.
</script>

<template>
  <main class="shell">
    <p class="eyebrow mono">
      Astolia &middot; collab add-on
    </p>
    <h1>Foundation</h1>
    <p class="note">
      Clock, RNG, id generator and canonical hashing are in place. Nothing renders
      real data yet, because the scoped repository is the only thing allowed to
      read it.
    </p>
  </main>
</template>

<style scoped>
.shell {
  max-width: 46rem;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.eyebrow {
  font-size: 0.68rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0;
}

h1 {
  font-size: 1.7rem;
  font-weight: 640;
  letter-spacing: -0.02em;
  text-wrap: balance;
  margin: var(--space-2) 0 var(--space-3);
}

.note {
  color: var(--muted);
  max-width: 62ch;
  margin: 0;
}
</style>
