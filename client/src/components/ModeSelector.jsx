import React from 'react';
import { SendIcon, DownloadIcon } from './Icons';

function ModeSelector({ setMode }) {
  return (
    <div className="mode-selector-container">
      <div className="mode-card" onClick={() => setMode('realtime')}>
        <div className="mode-card-icon"><SendIcon /></div>
        <h2>Real-Time Sharing</h2>
        <p>Transfer files directly to another user, peer-to-peer.</p>
      </div>
      <div className="mode-card" onClick={() => setMode('upload')}>
        <div className="mode-card-icon"><DownloadIcon /></div>
        <h2>24-Hour Upload</h2>
        <p>Get a temporary link that works for 24 hours.</p>
      </div>
    </div>
  );
}
export default ModeSelector;