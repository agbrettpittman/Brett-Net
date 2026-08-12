import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyTheme, readPref, resolveTheme, systemPrefersDark } from './lib/theme';

// Applied before the first paint, which is why the preference lives in
// localStorage rather than the settings file: reading it must be synchronous
// or the window flashes the wrong theme on launch.
applyTheme(resolveTheme(readPref(localStorage), systemPrefersDark()));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
