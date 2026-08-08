import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createAppRouter } from './app/router'
import './styles/tokens.css'

// Mount immediately and boot inside the shell, so the user sees a loading
// state instead of a blank page while IndexedDB opens and, on first run, the
// demo seed hydrates. App.vue re-runs the initial navigation once booted.
createApp(App).use(createPinia()).use(createAppRouter()).mount('#app')
