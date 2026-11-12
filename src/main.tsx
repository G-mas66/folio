import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './eye-comfort.css';
import './compact-ui.css';
import './claude-theme.css';

const container = document.getElementById('root')!;
function render() {
  createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);
}

if (import.meta.env.MODE === 'tablet') {
  document.documentElement.classList.add('folio-tablet');
  void import('./tablet').then(module => module.installTabletBridge()).then(render).catch(error => {
    container.textContent = error instanceof Error ? error.message : 'Folio 无法启动。';
  });
} else render();
