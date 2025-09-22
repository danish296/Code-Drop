import React from 'react';
import { Logo, InfoIcon, GitHubIcon } from './Icons';

function Navbar({ showInfo }) {
  return (
    <nav className="navbar">
      <div className="navbar-left">
        <a href="/" className="logo-container"> <Logo /> <h1>CodeDrop</h1> </a>
        <button className="icon-button" aria-label="Info" onClick={showInfo}> <InfoIcon /> </button>
      </div>
      <div className="navbar-right">
        <a href="https://github.com/your-repo" target="_blank" rel="noopener noreferrer" className="icon-button" aria-label="GitHub"> <GitHubIcon /> </a>
      </div>
    </nav>
  );
}
export default Navbar;