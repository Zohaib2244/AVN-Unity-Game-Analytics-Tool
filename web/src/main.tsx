import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './app/App';
import { installPopoverBehaviour } from './lib/popover-behaviour';

createRoot(document.getElementById('root')!).render(<App />);
installPopoverBehaviour();
