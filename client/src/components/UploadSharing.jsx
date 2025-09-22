import React, { useState } from 'react';
import { CopyIcon } from './Icons.jsx';

function UploadSharing() {
  const [file, setFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [shareableLink, setShareableLink] = useState('');
  const [showCopied, setShowCopied] = useState(false);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setShareableLink('');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      setFile(droppedFile);
      setShareableLink('');
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // This function now performs a real upload
  const handleUpload = () => {
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();

    // Listen for progress events
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percentComplete = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(percentComplete);
        setUploadStatus(`Uploading...`);
      }
    };

    // Handle completion
    xhr.onload = () => {
      if (xhr.status === 200) {
        const response = JSON.parse(xhr.responseText);
        setShareableLink(response.link);
        setUploadStatus('✅ Upload Complete!');
      } else {
        setUploadStatus('❌ Upload Failed. Please try again.');
        console.error('Upload failed:', xhr.statusText);
      }
      setIsUploading(false);
    };

    // Handle errors
    xhr.onerror = () => {
      setUploadStatus('❌ Network Error. Please check your connection.');
      setIsUploading(false);
      console.error('Network error during upload.');
    };

    // Start the upload
    xhr.open('POST', 'http://localhost:3001/api/upload');
    setIsUploading(true);
    setUploadProgress(0);
    setUploadStatus('Starting upload...');
    xhr.send(formData);
  };
  
  const copyLinkToClipboard = () => {
    if(!shareableLink) return;
    navigator.clipboard.writeText(shareableLink);
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

  return (
    <div className="sharing-container">
      {!file && (
        <label htmlFor="upload-input" className="dropzone" onDrop={handleDrop} onDragOver={handleDragOver}>
          <h2>24-Hour Upload</h2>
          <p><strong>Drag & Drop Your File</strong></p>
          <p className="dropzone-subtext">or Click to Select</p>
          <input id="upload-input" type="file" onChange={handleFileChange} style={{ display: 'none' }} />
        </label>
      )}

      {file && (
        <div className="file-info-container">
          <h2>File Ready for Upload</h2>
          <p className="file-name">{file.name} ({formatBytes(file.size)})</p>
          
          {(isUploading || shareableLink) && (
            <>
              <progress className="transfer-progress" value={uploadProgress} max="100"></progress>
              <p className="status-text">{uploadStatus} {isUploading && `(${uploadProgress}%)`}</p>
            </>
          )}

          {shareableLink && (
            <>
             <div className="shareable-link-wrapper">
                <input type="text" className="shareable-link-input" value={shareableLink} readOnly />
                <button className="icon-button" onClick={copyLinkToClipboard} aria-label="Copy link">
                    <CopyIcon />
                </button>
             </div>
             {showCopied && <span className="copied-feedback link-copied">Link Copied!</span>}
            </>
          )}
          
          {!isUploading && !shareableLink && (
            <button className="button-primary" style={{ marginTop: '1rem' }} onClick={handleUpload}>
              Upload
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default UploadSharing;