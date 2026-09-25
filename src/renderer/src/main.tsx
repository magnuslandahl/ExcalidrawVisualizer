import ReactDOM from 'react-dom/client'
import '@excalidraw/excalidraw/index.css'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Application root was not found')
}

ReactDOM.createRoot(root).render(
  <App />
)
