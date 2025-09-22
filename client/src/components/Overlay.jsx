import React from 'react';

function Overlay({ title, message, onClose }) {
  if (!message) return null;
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="overlay-title">{title}</h2>
        <p className="overlay-message">{message}</p>
        <button className="button-primary" onClick={onClose}> Got it </button>
      </div>
    </div>
  );
}
export default Overlay;