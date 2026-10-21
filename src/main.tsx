import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { startExportPage } from './render/export-page';
import './style.css';
if (new URLSearchParams(location.search).get('render') === '1') void startExportPage();
else createRoot(document.getElementById('root')!).render(<App />);
