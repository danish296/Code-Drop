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
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Add TURN servers for better connectivity (you'll need to set these up or use a service)
    // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'balanced',
  rtcpMuxPolicy: 'require'
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
  const connectionTimeoutRef = useRef(null);
  const isConnectedRef = useRef(false);
  const isSenderRef = useRef(false);
  const heartbeatIntervalRef = useRef(null);
  const retryConnectionRef = useRef(0);
  const maxRetries = 3;
  
  useEffect(() => { 
    document.documentElement.setAttribute('data-theme', theme); 
  }, [theme]);
  
  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');
  const showInfo = () => setOverlay({ title: 'About CodeDrop', message: 'A peer-to-peer file sharing tool.' });
  const closeOverlay = () => setOverlay({ title: '', message: '' });

  // Clear connection timeout
  const clearConnectionTimeout = () => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
  };

  // Set connection timeout
  const setConnectionTimeout = (callback, delay = 30000) => {
    clearConnectionTimeout();
    connectionTimeoutRef.current = setTimeout(callback, delay);
  };

  const cleanupConnection = () => {
    console.log('🧹 Cleaning up connection...');
    
    clearConnectionTimeout();
    
    // Clear heartbeat
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    
    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch (e) {
        console.error('Error closing data channel:', e);
      }
      dataChannelRef.current = null;
    }
    
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (e) {
        console.error('Error closing peer connection:', e);
      }
      peerConnectionRef.current = null;
    }
    
    isConnectedRef.current = false;
    pendingIceCandidates.current = [];
  };

  const setupDataChannelEvents = (channel, isSender = false) => {
    console.log('📡 Setting up data channel events, isSender:', isSender, 'readyState:', channel.readyState);
    
    channel.onopen = () => {
        console.log('✅ Data channel opened, isSender:', isSender);
        clearConnectionTimeout();
        isConnectedRef.current = true;
        
        // Start heartbeat mechanism
        heartbeatIntervalRef.current = setInterval(() => {
          if (channel.readyState === 'open') {
            try {
              channel.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            } catch (e) {
              console.error('❌ Heartbeat ping failed:', e);
              cleanupConnection();
            }
          }
        }, 5000);
        
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
                
                if (message.type === 'ping') {
                    // Respond to ping with pong
                    try {
                      channel.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    } catch (e) {
                      console.error('❌ Failed to send pong:', e);
                    }
                    return;
                }
                
                if (message.type === 'pong') {
                    lastPongRef.current = Date.now();
                    return;
                }
                
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
        isConnectedRef.current = false;
        
        if (isSender) {
            setSenderStatus('❌ Connection lost');
        } else {
            setReceiverStatus('❌ Connection lost');
        }
    };
  };

  useEffect(() => {
    socketRef.current = io('https://code-drop.onrender.com', {
      transports: ['websocket', 'polling'],
      timeout: 10000,
      forceNew: true
    });
    const socket = socketRef.current;
    
    const createPeerConnection = () => {
        console.log('🔄 Creating peer connection...');
        
        cleanupConnection();
        
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
                clearConnectionTimeout();
                
            } else if (pc.connectionState === 'failed') {
                console.error('❌ Peer connection failed');
                setSenderStatus('❌ Connection failed');
                setReceiverStatus('❌ Connection failed');
                cleanupConnection();
                
            } else if (pc.connectionState === 'disconnected') {
                console.warn('⚠️ Peer connection disconnected');
                if (isConnectedRef.current) {
                    setSenderStatus('⚠️ Connection lost, retrying...');
                    setReceiverStatus('⚠️ Connection lost, retrying...');
                }
                
            } else if (pc.connectionState === 'closed') {
                console.log('🔒 Peer connection closed');
                isConnectedRef.current = false;
            }
        };

        pc.onicegatheringstatechange = () => {
            console.log('🧊 ICE gathering state:', pc.iceGatheringState);
        };

        pc.oniceconnectionstatechange = () => {
            console.log('🧊 ICE connection state:', pc.iceConnectionState);
            
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                console.log('✅ ICE connection established');
                clearConnectionTimeout();
                retryConnectionRef.current = 0; // Reset retry counter on success
                
            } else if (pc.iceConnectionState === 'failed') {
                console.error('❌ ICE connection failed');
                
                // Try ICE restart if retries available
                if (retryConnectionRef.current < maxRetries) {
                    retryConnectionRef.current++;
                    console.log(`🔄 Attempting ICE restart (attempt ${retryConnectionRef.current}/${maxRetries})...`);
                    setSenderStatus(`🔄 Retrying connection (${retryConnectionRef.current}/${maxRetries})...`);
                    setReceiverStatus(`🔄 Retrying connection (${retryConnectionRef.current}/${maxRetries})...`);
                    
                    if (pc.restartIce) {
                        pc.restartIce();
                    } else {
                        // Manual restart - create new offer/answer
                        setTimeout(async () => {
                            try {
                                if (isSenderRef.current && remoteUserIdRef.current) {
                                    const offer = await pc.createOffer({ iceRestart: true });
                                    await pc.setLocalDescription(offer);
                                    socketRef.current.emit('offer', { sdp: offer, target: remoteUserIdRef.current });
                                }
                            } catch (e) {
                                console.error('❌ Manual restart failed:', e);
                                cleanupConnection();
                            }
                        }, 1000);
                    }
                } else {
                    setSenderStatus('❌ Connection failed after retries');
                    setReceiverStatus('❌ Connection failed after retries');
                    cleanupConnection();
                }
                
            } else if (pc.iceConnectionState === 'disconnected') {
                console.warn('⚠️ ICE connection disconnected');
                setSenderStatus('⚠️ Connection lost, retrying...');
                setReceiverStatus('⚠️ Connection lost, retrying...');
                
                // Set timeout for reconnection
                setTimeout(() => {
                    if (pc.iceConnectionState === 'disconnected') {
                        console.error('❌ Reconnection timeout');
                        cleanupConnection();
                    }
                }, 10000);
                
            } else if (pc.iceConnectionState === 'closed') {
                console.log('🔒 ICE connection closed');
                isConnectedRef.current = false;
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

    socket.on('connect', () => {
        console.log('✅ Socket connected to server');
    });

    socket.on('disconnect', (reason) => {
        console.log('❌ Socket disconnected:', reason);
        cleanupConnection();
        setSenderStatus('❌ Server disconnected');
        setReceiverStatus('❌ Server disconnected');
    });

    socket.on('room-created', (code) => { 
        console.log('🚀 Room created:', code);
        setSharingCode(code); 
        currentRoomCode.current = code; 
        isSenderRef.current = true;
        setSenderStatus('Waiting for receiver to join...');
        
        // Set timeout for waiting for receiver
        setConnectionTimeout(() => {
            setSenderStatus('❌ No receiver joined. Try again.');
        }, 60000);
    });
    
    socket.on('error', (message) => {
        console.error('❌ Socket error:', message);
        setOverlay({ title: 'Error', message });
        cleanupConnection();
    });

    socket.on('receiver-joined', async ({ receiverId }) => {
        console.log('👋 Receiver joined:', receiverId);
        remoteUserIdRef.current = receiverId;
        setSenderStatus('🤝 Receiver connected! Setting up P2P...');
        
        // Set timeout for P2P connection establishment
        setConnectionTimeout(() => {
            console.error('❌ P2P connection timeout');
            setSenderStatus('❌ Connection timeout');
            cleanupConnection();
        }, 30000);
        
        try {
            peerConnectionRef.current = createPeerConnection();
            
            // Create data channel for sender with more robust configuration
            console.log('📡 Creating data channel for sender...');
            const dataChannel = peerConnectionRef.current.createDataChannel('file-transfer', {
                ordered: true,
                maxPacketLifeTime: 3000,
                maxRetransmits: null
            });
            
            dataChannelRef.current = dataChannel;
            setupDataChannelEvents(dataChannel, true);
            
            // Wait for ICE gathering to complete or timeout
            console.log('🧊 Waiting for ICE gathering...');
            const gatheringPromise = new Promise((resolve) => {
                if (peerConnectionRef.current.iceGatheringState === 'complete') {
                    resolve();
                    return;
                }
                
                const timeout = setTimeout(() => {
                    console.log('⏰ ICE gathering timeout, proceeding anyway');
                    resolve();
                }, 5000);
                
                peerConnectionRef.current.addEventListener('icegatheringstatechange', () => {
                    if (peerConnectionRef.current.iceGatheringState === 'complete') {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            });
            
            console.log('📤 Creating offer...');
            const offer = await peerConnectionRef.current.createOffer({
                offerToReceiveAudio: false,
                offerToReceiveVideo: false
            });
            
            console.log('📤 Setting local description...');
            await peerConnectionRef.current.setLocalDescription(offer);
            
            // Wait for ICE gathering with timeout
            await gatheringPromise;
            
            console.log('📤 Sending offer with', peerConnectionRef.current.localDescription.sdp.split('\n').filter(line => line.includes('a=candidate')).length, 'ICE candidates');
            socket.emit('offer', { sdp: peerConnectionRef.current.localDescription, target: receiverId });
            
        } catch (error) {
            console.error('❌ Error in receiver-joined:', error);
            setSenderStatus('❌ Error setting up connection');
            cleanupConnection();
        }
    });

    socket.on('offer', async ({ sdp, senderId }) => {
        console.log('📨 Offer received from:', senderId);
        remoteUserIdRef.current = senderId;
        isSenderRef.current = false;
        setReceiverStatus('🤝 Offer received! Connecting...');
        
        // Set timeout for connection establishment
        setConnectionTimeout(() => {
            console.error('❌ Connection timeout');
            setReceiverStatus('❌ Connection timeout');
            cleanupConnection();
        }, 30000);
        
        try {
            peerConnectionRef.current = createPeerConnection();
            
            console.log('📥 Setting remote description...');
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
            
            // Wait for ICE gathering to complete or timeout
            console.log('🧊 Creating answer and waiting for ICE gathering...');
            const answer = await peerConnectionRef.current.createAnswer();
            await peerConnectionRef.current.setLocalDescription(answer);
            
            const gatheringPromise = new Promise((resolve) => {
                if (peerConnectionRef.current.iceGatheringState === 'complete') {
                    resolve();
                    return;
                }
                
                const timeout = setTimeout(() => {
                    console.log('⏰ ICE gathering timeout, proceeding anyway');
                    resolve();
                }, 5000);
                
                peerConnectionRef.current.addEventListener('icegatheringstatechange', () => {
                    if (peerConnectionRef.current.iceGatheringState === 'complete') {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            });
            
            await gatheringPromise;
            
            console.log('📤 Sending answer with', peerConnectionRef.current.localDescription.sdp.split('\n').filter(line => line.includes('a=candidate')).length, 'ICE candidates');
            socket.emit('answer', { sdp: peerConnectionRef.current.localDescription, target: senderId });
            
        } catch (error) {
            console.error('❌ Error handling offer:', error);
            setReceiverStatus('❌ Error processing offer');
            cleanupConnection();
        }
    });

    socket.on('answer', async ({ sdp }) => {
        console.log('📨 Answer received');
        try {
            if (peerConnectionRef.current && peerConnectionRef.current.signalingState === 'have-local-offer') {
                await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
                console.log('✅ Remote description set successfully');
                
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
            cleanupConnection();
        }
    });

    socket.on('ice-candidate', async ({ candidate }) => {
        console.log('🧊 ICE candidate received');
        if (candidate && peerConnectionRef.current) {
            try {
                if (peerConnectionRef.current.remoteDescription && peerConnectionRef.current.remoteDescription.type) {
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

    socket.on('peer-disconnected', () => {
        console.log('👋 Peer disconnected');
        cleanupConnection();
        setSenderStatus('👋 Peer disconnected');
        setReceiverStatus('👋 Peer disconnected');
    });

    socket.on('room-joined', (roomCode) => {
        console.log('✅ Successfully joined room:', roomCode);
        setReceiverStatus('✅ Joined room! Waiting for connection...');
    });

    socket.on('pong', () => {
        lastPongRef.current = Date.now();
    });

    // Add heartbeat mechanism for socket connection
    const socketHeartbeat = setInterval(() => {
        if (socketRef.current && socketRef.current.connected) {
            socketRef.current.emit('ping');
            
            // Check if we haven't received a pong in too long
            if (Date.now() - lastPongRef.current > 15000) {
                console.error('❌ Socket heartbeat timeout');
                cleanupConnection();
                setSenderStatus('❌ Server connection lost');
                setReceiverStatus('❌ Server connection lost');
            }
        }
    }, 5000);

    return () => {
        clearInterval(socketHeartbeat);
        cleanupConnection();
        if (socketRef.current) {
            socketRef.current.disconnect();
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
                if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
                    dataChannelRef.current.send(event.target.result);
                    chunkCount++;
                    offset += event.target.result.byteLength;
                    
                    const progress = Math.min((offset / file.size) * 100, 100);
                    setTransferProgress(Math.round(progress));
                    
                    console.log(`📤 Sent chunk ${chunkCount}, ${offset}/${file.size} bytes (${Math.round(progress)}%)`);
                    
                    // Continue reading next chunk
                    setTimeout(readChunk, 10); // Small delay to prevent overwhelming
                } else {
                    console.error('❌ Data channel not ready during transfer');
                    setSenderStatus('❌ Connection lost during transfer');
                }
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
      
      // Clean any existing connection
      cleanupConnection();
      
      socketRef.current.emit('create-room');
    }
  };

  const handleJoinRoom = (roomCode) => {
    if (roomCode.length === 4) {
      console.log('🚪 Attempting to join room:', roomCode);
      currentRoomCode.current = roomCode;
      setReceiverStatus('⏳ Joining room...');
      
      // Clean any existing connection
      cleanupConnection();
      isSenderRef.current = false;
      
      // Set timeout for joining room
      setConnectionTimeout(() => {
        setReceiverStatus('❌ Failed to join room');
      }, 10000);
      
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
            canSendFile={dataChannelRef.current && dataChannelRef.current.readyState === 'open' && isConnectedRef.current}
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