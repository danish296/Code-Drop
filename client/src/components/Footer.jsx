import React from 'react';
import { ThemeIcon } from './Icons';

function Footer({ toggleTheme }) {
  return (
    <footer className="footer">
      <div className="scan-bar"></div>
      <div className="footer-content">
        <p>© 2025 CodeDrop</p>
        <button className="icon-button theme-toggle" onClick={toggleTheme} aria-label="Toggle Theme"> <ThemeIcon /> </button>
      </div>
    </footer>
  );
}
export default Footer;