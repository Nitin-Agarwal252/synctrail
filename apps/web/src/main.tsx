import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { registerSW } from 'virtual:pwa-register';

// Register service worker immediately for offline precaching & navigation fallback
registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
);
