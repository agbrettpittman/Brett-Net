import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

const stored = localStorage.getItem('theme');
document.documentElement.dataset.theme =
  stored ??
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
