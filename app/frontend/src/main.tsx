import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initializeInspectorPanels } from './inspectorPanels';
import './App.css';

// Phase P.3 - Eagerly register every shipped inspector panel before
// React renders. Inspector dispatch lives in `lib/inspectorRegistry`;
// each panel module declares the EntityKind it handles. New per-entity
// inspectors land here as Phase S subphases ship.
initializeInspectorPanels();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
