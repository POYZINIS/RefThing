import { createRoot } from 'react-dom/client';
import { DevBoard } from './DevBoard';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root not found in board.html');

// No StrictMode: this is a perf harness, and double-mount effects would
// pollute frame measurements.
createRoot(container).render(<DevBoard />);
