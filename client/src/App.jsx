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
    // Free TURN servers for better connectivity
    { 
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    { 
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    { 
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
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
  const lastPongRef = useRef(Date.now()); // Fixed: Added missing ref
  const statsIntervalRef = useRef(null);
  
  const maxRetries = 3;
  
  useEffect(() => { 
    document.documentElement.setAttribute('data-theme', theme); 
  }, [theme]);
  
  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');
  const showInfo = () => setOverlay({ title: 'About CodeDrop', message: 'A peer-to-peer file sharing tool.' });
  const closeOverlay = () => setOverlay({ title: '', message: '' });

  // Get retry delay with exponential backoff
  const getRetryDelay = (attempt) => Math.min(1000 * Math.pow(2, attempt), 30000);

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

  // Handle connection failure
  const handleConnectionFailure = () => {
    const failureMessage = '❌ Connection failed after retries';
    setSenderStatus(failureMessage);
    setReceiverStatus(failureMessage);
    cleanupConnection();
    
    // Optionally, try to recreate the room/connection after a delay
    setTimeout(() => {
      if (isSenderRef.current && file) {
        console.log('🔄 Attempting to recreate room...');
        setSenderStatus('🔄 Recreating room...');
        retryConnectionRef.current = 0; // Reset retry counter
        socketRef.current.emit('create-room');
      }
    }, 5000);
  };

  // Monitor connection quality
  const monitorConnectionQuality = (pc) => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }
    
    statsIntervalRef.current = setInterval(async () => {
      if (pc && pc.connectionState === 'connected') {
        try {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              console.log('📊 Connection stats:', {
                rtt: report.currentRoundTripTime,
                bytesReceived: report.bytesReceived,
                bytesSent: report.bytesSent
              });
              
              // Monitor for poor connection quality
              if (report.currentRoundTripTime > 1.0) { // RTT > 1 second
                console.warn('⚠️ High latency detected:', report.currentRoundTripTime);
              }
            }
          });
        } catch (error) {
          console.error('❌ Error getting connection stats:', error);
        }
      } else {
        if (statsIntervalRef.current) {
          clearInterval(statsIntervalRef.current);
          statsIntervalRef.current = null;
        }
      }
    }, 30000); // Check every 30 seconds
    
    return statsIntervalRef.current;
  };

  const cleanupConnection = () => {
    console.log('🧹 Cleaning up connection...');
    
    clearConnectionTimeout();
    
    // Clear heartbeat
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    
    // Clear stats monitoring
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
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

  // Restart peer connection
  const restartPeerConnection = async () => {
    console.log('🔄 Restarting peer connection...');
    
    if (!currentRoomCode.current || !remoteUserIdRef.current) {
      console.error('❌ Cannot restart - missing room or remote user info');
      return;
    }
    
    try {
      // Clean up old connection
      cleanupConnection();
      
      // Create new connection
      peerConnectionRef.current = createPeerConnection();
      
      if (isSenderRef.current) {
        // Recreate data channel for sender
        const dataChannel = peerConnectionRef.current.createDataChannel('file-transfer', {
          ordered: true,
          maxPacketLifeTime: null, // Reliable delivery
          maxRetransmits: 0,
          protocol: 'file-transfer-v1'
        });
        
        dataChannelRef.current = dataChannel;
        setupDataChannelEvents(dataChannel, true);
        
        // Create new offer
        const offer = await peerConnectionRef.current.createOffer();
        await peerConnectionRef.current.setLocalDescription(offer);
        
        socketRef.current.emit('offer', { 
          sdp: peerConnectionRef.current.localDescription, 
          target: remoteUserIdRef.current,
          isRestart: true // Flag to indicate this is a restart
        });
      }
    } catch (error) {
      console.error('❌ Error restarting connection:', error);
      handleConnectionFailure();
    }
  };

  const setupDataChannelEvents = (channel, isSender = false) => {
    console.log('📡 Setting up data channel events, isSender:', isSender, 'readyState:', channel.readyState);
    
    channel.onopen = () => {
        console.log('✅ Data channel opened, isSender:', isSender);
        clearConnectionTimeout();
        isConnectedRef.current = true;
        retryConnectionRef.current = 0; // Reset retry counter
        
        // Clear any existing heartbeat
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
        }
        
        // Start heartbeat mechanism with improved error handling
        heartbeatIntervalRef.current = setInterval(() => {
          if (channel.readyState === 'open') {
            try {
              channel.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            } catch (e) {
              console.error('❌ Heartbeat ping failed:', e);
              // Don't immediately cleanup - let connection state handlers deal with it
            }
          } else {
            console.warn('⚠️ Heartbeat skipped - channel not open:', channel.readyState);
          }
        }, 10000); // Reduce frequency to every 10 seconds
        
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
        
        // More specific error handling
        const errorMessage = error.error ? error.error.message : 'Connection error';
        if (isSender) {
            setSenderStatus(`❌ ${errorMessage}`);
        } else {
            setReceiverStatus(`❌ ${errorMessage}`);
        }
    };

    channel.onclose = () => {
        console.log('📡 Data channel closed');
        
        // Clear heartbeat when channel closes
        if (heartbeatIntervalRef.current) {
            clearInterval(heartbeatIntervalRef.current);
            heartbeatIntervalRef.current = null;
        }
        
        // Only show "lost" message if we were previously connected
        const wasConnected = isConnectedRef.current;
        isConnectedRef.current = false;
        
        if (wasConnected) {
            if (isSender) {
                setSenderStatus('❌ Connection lost');
            } else {
                setReceiverStatus('❌ Connection lost');
            }
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
        
        // Start connection quality monitoring
        monitorConnectionQuality(pc);
        
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
                retryConnectionRef.current = 0; // Reset retry counter
                
            } else if (pc.connectionState === 'failed') {
                console.error('❌ Peer connection failed');
                
                // Only retry if we haven't exceeded max retries
                if (retryConnectionRef.current < maxRetries) {
                    retryConnectionRef.current++;
                    console.log(`🔄 Retrying connection (${retryConnectionRef.current}/${maxRetries})...`);
                    
                    // Set status based on role
                    const statusMessage = `🔄 Retrying connection (${retryConnectionRef.current}/${maxRetries})...`;
                    if (isSenderRef.current) {
                        setSenderStatus(statusMessage);
                    } else {
                        setReceiverStatus(statusMessage);
                    }
                    
                    // Attempt to restart the ICE connection with exponential backoff
                    const delay = getRetryDelay(retryConnectionRef.current - 1);
                    setTimeout(async () => {
                        try {
                            if (pc.restartIce) {
                                pc.restartIce();
                            } else {
                                // Manual restart - recreate the connection
                                await restartPeerConnection();
                            }
                        } catch (error) {
                            console.error('❌ Restart failed:', error);
                            handleConnectionFailure();
                        }
                    }, delay);
                    
                } else {
                    handleConnectionFailure();
                }
                
            } else if (pc.connectionState === 'disconnected') {
                console.warn('⚠️ Peer connection disconnected');
                const statusMessage = '⚠️ Connection lost, attempting to reconnect...';
                if (isSenderRef.current) {
                    setSenderStatus(statusMessage);
                } else {
                    setReceiverStatus(statusMessage);
                }
                
                // Set a timeout to handle prolonged disconnection
                setTimeout(() => {
                    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                        console.error('❌ Connection timeout after disconnection');
                        handleConnectionFailure();
                    }
                }, 15000); // 15 second timeout
                
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
                retryConnectionRef.current = 0;
                
            } else if (pc.iceConnectionState === 'failed') {
                console.error('❌ ICE connection failed');
                
                // Don't immediately retry if peer connection will handle it
                if (pc.connectionState !== 'failed') {
                    console.log('🔄 ICE failed but peer connection still active, attempting ICE restart...');
                    if (pc.restartIce) {
                        pc.restartIce();
                    }
                }
                
            } else if (pc.iceConnectionState === 'disconnected') {
                console.warn('⚠️ ICE connection disconnected');
                
                // Give some time for reconnection before taking action
                setTimeout(() => {
                    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                        console.error('❌ ICE reconnection timeout');
                        // Let the peer connection state handler deal with this
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
        lastPongRef.current = Date.now(); // Reset pong timestamp
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
            
            // Create data channel for sender with improved configuration
            console.log('📡 Creating data channel for sender...');
            const dataChannel = peerConnectionRef.current.createDataChannel('file-transfer', {
                ordered: true,
                maxPacketLifeTime: null, // Reliable delivery
                maxRetransmits: 0,
                protocol: 'file-transfer-v1'
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

    socket.on('offer', async ({ sdp, senderId, isRestart }) => {
        console.log('📨 Offer received from:', senderId, 'isRestart:', !!isRestart);
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
            // If this is a restart, clean up first
            if (isRestart) {
                cleanupConnection();
            }
            
            if (!peerConnectionRef.current) {
                peerConnectionRef.current = createPeerConnection();
            }
            
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

    // Network change detection
    const handleNetworkChange = () => {
        console.log('🌐 Network change detected');
        if (isConnectedRef.current) {
            console.log('🔄 Attempting to recover from network change...');
            // Give some time for network to stabilize, then check connection
            setTimeout(() => {
                if (peerConnectionRef.current && peerConnectionRef.current.connectionState === 'disconnected') {
                    console.log('🔄 Restarting connection after network change...');
                    restartPeerConnection();
                }
            }, 2000);
        }
    };

    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);

    return () => {
        clearInterval(socketHeartbeat);
        window.removeEventListener('online', handleNetworkChange);
        window.removeEventListener('offline', handleNetworkChange);
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
                    
                    // Continue reading next chunk with adaptive delay
                    const delay = dataChannelRef.current.bufferedAmount > 64 * 1024 ? 50 : 10;
                    setTimeout(readChunk, delay);
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
      retryConnectionRef.current = 0; // Reset retry counter
      
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
      retryConnectionRef.current = 0; // Reset retry counter
      
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