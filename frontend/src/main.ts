import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
// Implements: .scratch/agent-ports-editor/PRD.md
// 端口色 token：AgentNode 与 PortsEditor 共用。
import './port-colors.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
