import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ModeSelector from './components/ModeSelector';
import RealtimeSharing from './components/RealtimeSharing';
import UploadSharing from './components/UploadSharing';
import Overlay from './components/Overlay';

const servers = { 
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, 
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};
const CHUNK_SIZE = 16 * 1024;

function App() {
  const [theme, setTheme] = useState('dark');
  const [mode, setMode] = useState(null);
  const [overlay, setOverlay] = useState({ title: '', message: '' });
  const [file, setFile] = useState(null);
  const [sharingCode, setSharingCode] = useState('');
  const [senderStatus, setSenderStatus] = useState('Select a file to begin');
  const [receiverStatus, setReceiverStatus] = useState('Enter a code to connect');
  const [transferProgress, setTransferProgress] = useState(0);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const receivedFileBuffer = useRef([]);
  const receivedFileSize = useRef(0);
  const currentRoomCode = useRef(null);
  const remoteUserIdRef = useRef(null);
  const fileInfoRef = useRef({ name: '', size: 0 });
  const pendingIceCandidates = useRef([]);
  
  useEffect(() => { 
    document.documentElement.setAttribute('data-theme', theme); 
  }, [theme]);
  
  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');
  const showInfo = () => setOverlay({ title: 'About CodeDrop', message: 'A peer-to-peer file sharing tool.' });
  const closeOverlay = () => setOverlay({ title: '', message: '' });

  const setupDataChannelEvents = (channel, isSender = false) => {
    console.log('📡 Setting up data channel events, isSender:', isSender, 'readyState:', channel.readyState);
    
    channel.onopen = () => {
        console.log('✅ Data channel opened, isSender:', isSender);
        if (isSender && file) {
            setSenderStatus('✅ Connected! Click to send file');
        } else {
            setReceiverStatus('✅ Connected! Waiting for file...');
        }
    };

    channel.onmessage = (event) => {
        if (typeof event.data === 'string') {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'file-start') {
                    console.log('📥 File transfer starting:', message.fileName);
                    setReceiverStatus(`📥 Receiving: ${message.fileName}`);
                    fileInfoRef.current = { name: message.fileName, size: message.fileSize };
                    receivedFileSize.current = message.fileSize;
                    receivedFileBuffer.current = [];
                    setTransferProgress(0);
                } else if (message.type === 'file-end') {
                    console.log('✅ File transfer complete');
                    handleFileComplete();
                }
            } catch (e) {
                console.error('Error parsing message:', e);
            }
        } else {
            // Binary data (file chunk)
            receivedFileBuffer.current.push(event.data);
            const receivedBytes = receivedFileBuffer.current.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const progress = (receivedBytes / receivedFileSize.current) * 100;
            setTransferProgress(Math.round(progress));
            console.log(`📥 Received ${receivedBytes}/${receivedFileSize.current} bytes (${Math.round(progress)}%)`);
        }
    };

    channel.onerror = (error) => {
        console.error('❌ Data channel error:', error);
        if (isSender) {
            setSenderStatus('❌ Connection error');
        } else {
            setReceiverStatus('❌ Connection error');
        }
    };

    channel.onclose = () => {
        console.log('📡 Data channel closed');
    };
  };

  useEffect(() => {
    socketRef.current = io('http://localhost:3001');
    const socket = socketRef.current;
    
    const createPeerConnection = () => {
        console.log('🔄 Creating peer connection...');
        
        // Close existing connection if any
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }
        
        const pc = new RTCPeerConnection(servers);
        
        pc.onicecandidate = (event) => {
            if (event.candidate && currentRoomCode.current) {
                console.log('🧊 Sending ICE candidate');
                socket.emit('ice-candidate', { 
                    candidate: event.candidate, 
                    roomCode: currentRoomCode.current,
                    target: remoteUserIdRef.current
                });
            }
        };
        
        pc.onconnectionstatechange = () => {
            console.log('🔗 Connection state:', pc.connectionState);
            if (pc.connectionState === 'connected') {
                console.log('✅ Peer connection established');
                // Additional check: if we have a file and this is the sender, update status
                if (file && dataChannelRef.current) {
                    console.log('📡 Data channel state:', dataChannelRef.current.readyState);
                    if (dataChannelRef.current.readyState === 'open') {
                        setSenderStatus('✅ Connected! Click to send file');
                    }
                }
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                setSenderStatus('❌ Connection failed');
                setReceiverStatus('❌ Connection failed');
            }
        };
        
        // Handle incoming data channels (for receiver)
        pc.ondatachannel = (event) => {
            console.log('📡 Data channel received by receiver');
            const channel = event.channel;
            dataChannelRef.current = channel;
            setupDataChannelEvents(channel, false);
        };
        
        return pc;
    };

    socket.on('room-created', (code) => { 
        console.log('🚀 Room created:', code);
        setSharingCode(code); 
        currentRoomCode.current = code; 
        setSenderStatus('Waiting for receiver to join...');
    });
    
    socket.on('error', (message) => {
        console.error('❌ Socket error:', message);
        setOverlay({ title: 'Error', message });
    });

    socket.on('receiver-joined', async ({ receiverId }) => {
        console.log('👋 Receiver joined:', receiverId);
        remoteUserIdRef.current = receiverId;
        setSenderStatus('🤝 Receiver connected! Setting up P2P...');
        
        try {
            peerConnectionRef.current = createPeerConnection();
            
            // Create data channel for sender
            console.log('📡 Creating data channel for sender...');
            const dataChannel = peerConnectionRef.current.createDataChannel('file-transfer', {
                ordered: true
            });
            
            dataChannelRef.current = dataChannel;
            setupDataChannelEvents(dataChannel, true);
            
            // Add a small delay to ensure data channel is ready
            setTimeout(() => {
                if (dataChannel.readyState === 'open') {
                    setSenderStatus('✅ Connected! Click to send file');
                } else {
                    console.log('⏳ Data channel not open yet, state:', dataChannel.readyState);
                }
            }, 1000);
            
            console.log('📤 Creating and sending offer...');
            const offer = await peerConnectionRef.current.createOffer();
            await peerConnectionRef.current.setLocalDescription(offer);
            
            socket.emit('offer', { sdp: offer, target: receiverId });
        } catch (error) {
            console.error('❌ Error in receiver-joined:', error);
            setSenderStatus('❌ Error setting up connection');
        }
    });

    socket.on('offer', async ({ sdp, senderId }) => {
        console.log('📨 Offer received from:', senderId);
        remoteUserIdRef.current = senderId;
        setReceiverStatus('🤝 Offer received! Connecting...');
        
        try {
            peerConnectionRef.current = createPeerConnection();
            
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
            
            // Process any pending ICE candidates
            for (const candidate of pendingIceCandidates.current) {
                try {
                    await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                    console.log('✅ Added pending ICE candidate');
                } catch (err) {
                    console.error('❌ Error adding pending ICE candidate:', err);
                }
            }
            pendingIceCandidates.current = [];
            
            const answer = await peerConnectionRef.current.createAnswer();
            await peerConnectionRef.current.setLocalDescription(answer);
            
            console.log('📤 Sending answer');
            socket.emit('answer', { sdp: answer, target: senderId });
        } catch (error) {
            console.error('❌ Error handling offer:', error);
            setReceiverStatus('❌ Error processing offer');
        }
    });

    socket.on('answer', async ({ sdp }) => {
        console.log('📨 Answer received');
        try {
            if (peerConnectionRef.current && peerConnectionRef.current.signalingState === 'have-local-offer') {
                await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
                console.log('✅ Remote description set successfully');
                setSenderStatus('🔗 Connection established!');
                
                // Process any pending ICE candidates
                for (const candidate of pendingIceCandidates.current) {
                    try {
                        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                        console.log('✅ Added pending ICE candidate');
                    } catch (err) {
                        console.error('❌ Error adding pending ICE candidate:', err);
                    }
                }
                pendingIceCandidates.current = [];
            }
        } catch (error) {
            console.error('❌ Error handling answer:', error);
            setSenderStatus('❌ Error processing answer');
        }
    });

    socket.on('ice-candidate', async ({ candidate }) => {
        console.log('🧊 ICE candidate received');
        if (candidate && peerConnectionRef.current) {
            try {
                if (peerConnectionRef.current.remoteDescription) {
                    await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                    console.log('✅ ICE candidate added successfully');
                } else {
                    console.log('⏳ Queuing ICE candidate (remote description not set yet)');
                    pendingIceCandidates.current.push(candidate);
                }
            } catch (error) {
                console.error('❌ Error adding ICE candidate:', error);
            }
        }
    });

    return () => {
        if (socketRef.current) {
            socketRef.current.disconnect();
        }
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }
    };
  }, []); // Empty dependency array - socket should only be created once
  
  const handleFileComplete = () => {
    try {
        console.log('📁 Reconstructing file from', receivedFileBuffer.current.length, 'chunks');
        const blob = new Blob(receivedFileBuffer.current);
        const url = URL.createObjectURL(blob);
        
        // Create download link
        const a = document.createElement('a');
        a.href = url;
        a.download = fileInfoRef.current.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log('✅ File download initiated');
        setReceiverStatus('✅ File downloaded successfully!');
        setTransferProgress(100);
        
        // Reset after delay
        setTimeout(() => {
            setTransferProgress(0);
            setReceiverStatus('Ready to receive another file');
            receivedFileBuffer.current = [];
        }, 3000);
    } catch (error) {
        console.error('❌ Error completing file download:', error);
        setReceiverStatus('❌ Error downloading file');
    }
  };

  const sendFile = () => {
    if (!file || !dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
        console.error('❌ Cannot send file - connection not ready');
        console.log('File:', !!file, 'Channel:', !!dataChannelRef.current, 'State:', dataChannelRef.current?.readyState);
        setSenderStatus('❌ Connection not ready');
        return;
    }

    console.log('📤 Starting file transfer:', file.name, file.size, 'bytes');
    setSenderStatus(`📤 Sending: ${file.name}`);
    setTransferProgress(0);

    try {
        // Send file metadata
        const startMessage = JSON.stringify({
            type: 'file-start',
            fileName: file.name,
            fileSize: file.size
        });
        
        dataChannelRef.current.send(startMessage);
        console.log('📤 Sent file metadata');

        // Send file in chunks
        const fileReader = new FileReader();
        let offset = 0;
        let chunkCount = 0;

        const readChunk = () => {
            if (offset >= file.size) {
                // File transfer complete
                const endMessage = JSON.stringify({
                    type: 'file-end',
                    fileName: file.name
                });
                dataChannelRef.current.send(endMessage);
                console.log('✅ File transfer completed');
                setSenderStatus('✅ File sent successfully!');
                
                setTimeout(() => {
                    setTransferProgress(0);
                    setSenderStatus('Ready to send another file');
                }, 3000);
                return;
            }

            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            fileReader.readAsArrayBuffer(chunk);
        };

        fileReader.onload = (event) => {
            try {
                dataChannelRef.current.send(event.target.result);
                chunkCount++;
                offset += event.target.result.byteLength;
                
                const progress = Math.min((offset / file.size) * 100, 100);
                setTransferProgress(Math.round(progress));
                
                console.log(`📤 Sent chunk ${chunkCount}, ${offset}/${file.size} bytes (${Math.round(progress)}%)`);
                
                // Continue reading next chunk
                setTimeout(readChunk, 0); // Use setTimeout to prevent call stack overflow
            } catch (error) {
                console.error('❌ Error sending chunk:', error);
                setSenderStatus('❌ Error sending file');
            }
        };

        fileReader.onerror = (error) => {
            console.error('❌ FileReader error:', error);
            setSenderStatus('❌ Error reading file');
        };

        readChunk();
    } catch (error) {
        console.error('❌ Error starting file transfer:', error);
        setSenderStatus('❌ Error starting transfer');
    }
  };

  const handleFileSelect = (selectedFile) => {
    if (selectedFile) {
      console.log('📁 File selected:', selectedFile.name, selectedFile.size, 'bytes');
      setFile(selectedFile);
      setSenderStatus('Creating room...');
      socketRef.current.emit('create-room');
    }
  };

  const handleJoinRoom = (roomCode) => {
    if (roomCode.length === 4) {
      console.log('🚪 Attempting to join room:', roomCode);
      currentRoomCode.current = roomCode;
      setReceiverStatus('⏳ Joining room...');
      socketRef.current.emit('join-room', roomCode);
    } else {
      setOverlay({ title: 'Invalid Code', message: 'Please enter a valid 4-digit code.' });
    }
  };

  const renderContent = () => {
    switch (mode) {
      case 'realtime':
        return (
          <RealtimeSharing 
            onFileSelect={handleFileSelect} 
            onJoinRoom={handleJoinRoom} 
            file={file} 
            sharingCode={sharingCode} 
            senderStatus={senderStatus} 
            receiverStatus={receiverStatus} 
            transferProgress={transferProgress}
            onSendFile={sendFile}
            canSendFile={dataChannelRef.current && dataChannelRef.current.readyState === 'open'}
          />
        );
      case 'upload':
        return <UploadSharing />;
      default:
        return <ModeSelector setMode={setMode} />;
    }
  };

  return (
    <div className="app-layout">
      <Navbar showInfo={showInfo} />
      <main className="main-content">{renderContent()}</main>
      <Footer toggleTheme={toggleTheme} />
      <Overlay title={overlay.title} message={overlay.message} onClose={closeOverlay} />
    </div>
  );
}

export default App;