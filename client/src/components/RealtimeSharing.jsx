import React, { useState } from 'react';
import { CopyIcon } from './Icons.jsx';

function RealtimeSharing(props) {
  const { 
    onFileSelect, 
    onJoinRoom, 
    file, 
    sharingCode, 
    senderStatus, 
    receiverStatus, 
    transferProgress,
    onSendFile,
    canSendFile 
  } = props;
  
  const [role, setRole] = useState('sender');
  const [codeInput, setCodeInput] = useState('');
  const [showCopied, setShowCopied] = useState(false);

  const handleDrop = (e) => { 
    e.preventDefault(); 
    e.stopPropagation(); 
    onFileSelect(e.dataTransfer.files[0]); 
  };
  
  const handleDragOver = (e) => { 
    e.preventDefault(); 
    e.stopPropagation(); 
  };
  
  const handleFileChange = (e) => onFileSelect(e.target.files[0]);

  const copyCodeToClipboard = () => {
    if (!sharingCode) return;
    navigator.clipboard.writeText(sharingCode);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const formatBytes = (bytes = 0) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (role === 'sender') {
    return (
      <div className="sharing-container">
        {!file ? (
          <label htmlFor="file-input" className="dropzone" onDrop={handleDrop} onDragOver={handleDragOver}>
            <h2>Send a File</h2>
            <p><strong>Drag & Drop File Here</strong></p>
            <p className="dropzone-subtext">or Click to Select</p>
            <input type="file" id="file-input" onChange={handleFileChange} style={{ display: 'none' }} />
          </label>
        ) : (
          <div className="file-info-container">
            <h2>Your Sharing Code</h2>
            <p className="file-name">{file.name} ({formatBytes(file.size)})</p>
            <div className="sharing-code-wrapper">
              <strong className="sharing-code" onClick={copyCodeToClipboard}>
                {sharingCode || '----'}<CopyIcon />
              </strong>
              {showCopied && <span className="copied-feedback">Copied!</span>}
            </div>
            
            {/* Debug info - remove this later */}
            <div style={{fontSize: '12px', color: '#666', marginTop: '8px'}}>
              Debug: canSendFile={String(canSendFile)}, status: "{senderStatus}"
            </div>
            
            {/* Show Send File Button when ready - Updated condition */}
            {canSendFile && (senderStatus.includes('Click to send') || senderStatus.includes('Connection established')) && (
              <button 
                className="send-file-button" 
                onClick={onSendFile}
                style={{
                  padding: '12px 24px',
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '16px',
                  cursor: 'pointer',
                  marginTop: '16px'
                }}
              >
                📤 Send File
              </button>
            )}
            
            {/* Show progress bar during transfer */}
            {transferProgress > 0 && transferProgress < 100 && (
              <div style={{ marginTop: '16px' }}>
                <progress 
                  className="transfer-progress" 
                  value={transferProgress} 
                  max="100"
                  style={{ width: '100%', height: '20px' }}
                ></progress>
                <p style={{ textAlign: 'center', margin: '8px 0' }}>{transferProgress}%</p>
              </div>
            )}
            
            <p className="status-text" style={{ 
              marginTop: '16px', 
              padding: '8px', 
              backgroundColor: senderStatus.includes('✅') ? '#d4edda' : 
                             senderStatus.includes('❌') ? '#f8d7da' : '#fff3cd',
              color: senderStatus.includes('✅') ? '#155724' : 
                     senderStatus.includes('❌') ? '#721c24' : '#856404',
              borderRadius: '4px',
              textAlign: 'center'
            }}>
              {senderStatus}
            </p>
          </div>
        )}
        <p className="role-switcher">
          Not the sender? 
          <button onClick={() => setRole('receiver')}>Receive a file</button>
        </p>
      </div>
    );
  }

  return (
    <div className="sharing-container">
      <div className="receiver-container">
        <h2>Receive a File</h2>
        <p>Enter the 4-digit code from the sender.</p>
        <div className="receiver-input-group">
          <input 
            type="text" 
            className="code-input" 
            placeholder="1234" 
            maxLength="4" 
            value={codeInput} 
            onChange={(e) => setCodeInput(e.target.value.trim())} 
            onKeyUp={(e) => {
              if (e.key === 'Enter' && codeInput.length === 4) {
                onJoinRoom(codeInput);
              }
            }}
          />
          <button 
            className="button-primary" 
            onClick={() => onJoinRoom(codeInput)}
            disabled={codeInput.length !== 4}
          >
            Connect
          </button>
        </div>
        <div className="receiver-status">
          {/* Show progress bar during transfer */}
          {transferProgress > 0 && (
            <div style={{ marginTop: '16px' }}>
              <progress 
                className="transfer-progress" 
                value={transferProgress} 
                max="100"
                style={{ width: '100%', height: '20px' }}
              ></progress>
              <p style={{ textAlign: 'center', margin: '8px 0' }}>{transferProgress}%</p>
            </div>
          )}
          <p className="status-text" style={{ 
            marginTop: '16px', 
            padding: '8px', 
            backgroundColor: receiverStatus.includes('✅') ? '#d4edda' : 
                           receiverStatus.includes('❌') ? '#f8d7da' : '#fff3cd',
            color: receiverStatus.includes('✅') ? '#155724' : 
                   receiverStatus.includes('❌') ? '#721c24' : '#856404',
            borderRadius: '4px',
            textAlign: 'center'
          }}>
            {receiverStatus}
          </p>
        </div>
      </div>
      <p className="role-switcher">
        Not receiving? 
        <button onClick={() => setRole('sender')}>Send a file</button>
      </p>
    </div>
  );
}

export default RealtimeSharing;