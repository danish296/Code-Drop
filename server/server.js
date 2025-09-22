const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);

// --- File Upload Setup (Multer) ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
// Create the uploads directory if it doesn't exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Configure how files are stored
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // Create a unique filename to avoid collisions: timestamp + original name
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage: storage });

// --- Serve Uploaded Files Statically ---
// This makes files in the 'uploads' directory accessible via a URL
app.use('/files', express.static(UPLOADS_DIR));

// --- API Endpoint for File Upload ---
// The React app will send files to this endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }
  // Construct the shareable link
  // IMPORTANT: Replace with your actual server URL when deployed
  const fileUrl = `${req.protocol}://${req.get('host')}/files/${req.file.filename}`;
  res.status(200).json({ link: fileUrl });
});

// --- Scheduled File Cleanup (Cron Job) ---
// This task runs every hour to delete files older than 24 hours
cron.schedule('0 * * * *', () => {
  console.log('🧹 Running hourly cleanup job...');
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) {
      console.error("Could not list the directory.", err);
      return;
    }

    files.forEach((file, index) => {
      const filePath = path.join(UPLOADS_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err) {
          console.error("Error stating file.", err);
          return;
        }

        const now = new Date().getTime();
        const twentyFourHours = 24 * 60 * 60 * 1000;
        const fileAge = now - new Date(stat.mtime).getTime();

        if (fileAge > twentyFourHours) {
          console.log(`🗑️ Deleting old file: ${file}`);
          fs.unlink(filePath, (err) => {
            if (err) console.error(`Error deleting file: ${file}`, err);
          });
        }
      });
    });
  });
});

// --- Socket.IO Setup ---
const io = new Server(server, {
  cors: {
    origin: ["https://code-drop-theta.vercel.app", "http://localhost:3000", "https://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});
const PORT = process.env.PORT || 3001;

// Store room information with better structure
const rooms = new Map();
const userRooms = new Map(); // Track which room each user is in

// Helper function to clean up a room
const cleanupRoom = (roomCode, reason = 'cleanup') => {
  console.log(`🧹 Cleaning up room ${roomCode} (${reason})`);
  const roomInfo = rooms.get(roomCode);
  
  if (roomInfo) {
    // Notify users in the room
    if (roomInfo.sender && io.sockets.sockets.get(roomInfo.sender)) {
      io.to(roomInfo.sender).emit('room-closed', { reason });
    }
    if (roomInfo.receiver && io.sockets.sockets.get(roomInfo.receiver)) {
      io.to(roomInfo.receiver).emit('room-closed', { reason });
    }
    
    // Remove from tracking maps
    if (roomInfo.sender) {
      userRooms.delete(roomInfo.sender);
    }
    if (roomInfo.receiver) {
      userRooms.delete(roomInfo.receiver);
    }
    
    rooms.delete(roomCode);
  }
};

// Helper function to get room info safely
const getRoomInfo = (roomCode) => {
  return rooms.get(roomCode) || null;
};

// --- Enhanced Signaling Logic ---
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    // Clean up any existing room assignments for this socket
    const existingRoom = userRooms.get(socket.id);
    if (existingRoom) {
      cleanupRoom(existingRoom, 'user-reconnected');
    }

    socket.on('create-room', () => {
        try {
            // Clean up any existing room for this user
            const existingRoom = userRooms.get(socket.id);
            if (existingRoom) {
                cleanupRoom(existingRoom, 'new-room-created');
            }

            const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
            
            // Ensure room code is unique
            if (rooms.has(roomCode)) {
                socket.emit('create-room'); // Retry with new code
                return;
            }

            socket.join(roomCode);
            
            // Store room info
            const roomInfo = {
              sender: socket.id,
              receiver: null,
              created: Date.now(),
              lastActivity: Date.now()
            };
            
            rooms.set(roomCode, roomInfo);
            userRooms.set(socket.id, roomCode);
            
            socket.emit('room-created', roomCode);
            console.log(`🚀 Room created: ${roomCode} by ${socket.id}`);

            // Set room timeout (30 minutes)
            setTimeout(() => {
                if (rooms.has(roomCode)) {
                    const room = rooms.get(roomCode);
                    if (!room.receiver) {
                        cleanupRoom(roomCode, 'timeout-no-receiver');
                    }
                }
            }, 30 * 60 * 1000);

        } catch (error) {
            console.error('❌ Error creating room:', error);
            socket.emit('error', 'Failed to create room');
        }
    });

    socket.on('join-room', (roomCode) => {
        try {
            const roomInfo = getRoomInfo(roomCode);
            const socketRoom = io.sockets.adapter.rooms.get(roomCode);
            
            console.log(`🚪 Join attempt for room ${roomCode}:`, {
                roomExists: !!roomInfo,
                socketRoomSize: socketRoom?.size || 0,
                hasReceiver: roomInfo?.receiver ? true : false
            });

            if (!roomInfo) {
                socket.emit('error', 'Room not found');
                return;
            }

            if (roomInfo.receiver) {
                socket.emit('error', 'Room is full');
                return;
            }

            if (!socketRoom || socketRoom.size === 0) {
                socket.emit('error', 'Room is no longer active');
                return;
            }

            if (socketRoom.size >= 2) {
                socket.emit('error', 'Room is full');
                return;
            }

            // Clean up any existing room for this user
            const existingRoom = userRooms.get(socket.id);
            if (existingRoom && existingRoom !== roomCode) {
                cleanupRoom(existingRoom, 'user-joined-new-room');
            }

            socket.join(roomCode);
            
            // Update room info
            roomInfo.receiver = socket.id;
            roomInfo.lastActivity = Date.now();
            userRooms.set(socket.id, roomCode);
            
            console.log(`👋 User ${socket.id} joined room ${roomCode}`);
            
            // Notify both users
            socket.emit('room-joined', roomCode);
            
            // Notify the sender that receiver has joined
            if (roomInfo.sender && io.sockets.sockets.get(roomInfo.sender)) {
                io.to(roomInfo.sender).emit('receiver-joined', { 
                    receiverId: socket.id,
                    roomCode: roomCode 
                });
            }
            
        } catch (error) {
            console.error('❌ Error joining room:', error);
            socket.emit('error', 'Failed to join room');
        }
    });

    // Enhanced WebRTC signaling with better error handling
    socket.on('offer', (payload) => {
        try {
            if (!payload.target || !payload.sdp) {
                console.error('❌ Invalid offer payload');
                return;
            }

            const roomCode = userRooms.get(socket.id);
            if (!roomCode) {
                console.error('❌ User not in any room');
                socket.emit('error', 'Not in any room');
                return;
            }

            const roomInfo = getRoomInfo(roomCode);
            if (!roomInfo || roomInfo.sender !== socket.id) {
                console.error('❌ Unauthorized offer from non-sender');
                return;
            }

            console.log(`📤 Relaying offer from ${socket.id} to ${payload.target} in room ${roomCode}`);
            
            // Update room activity
            roomInfo.lastActivity = Date.now();
            
            // Check if target is still connected
            if (!io.sockets.sockets.get(payload.target)) {
                console.error('❌ Target user not connected');
                socket.emit('error', 'Receiver disconnected');
                return;
            }

            io.to(payload.target).emit('offer', { 
                sdp: payload.sdp, 
                senderId: socket.id,
                roomCode: roomCode
            });
        } catch (error) {
            console.error('❌ Error handling offer:', error);
            socket.emit('error', 'Failed to process offer');
        }
    });

    socket.on('answer', (payload) => {
        try {
            if (!payload.target || !payload.sdp) {
                console.error('❌ Invalid answer payload');
                return;
            }

            const roomCode = userRooms.get(socket.id);
            if (!roomCode) {
                console.error('❌ User not in any room');
                socket.emit('error', 'Not in any room');
                return;
            }

            const roomInfo = getRoomInfo(roomCode);
            if (!roomInfo || roomInfo.receiver !== socket.id) {
                console.error('❌ Unauthorized answer from non-receiver');
                return;
            }

            console.log(`📤 Relaying answer from ${socket.id} to ${payload.target} in room ${roomCode}`);
            
            // Update room activity
            roomInfo.lastActivity = Date.now();
            
            // Check if target is still connected
            if (!io.sockets.sockets.get(payload.target)) {
                console.error('❌ Target user not connected');
                socket.emit('error', 'Sender disconnected');
                return;
            }

            io.to(payload.target).emit('answer', { 
                sdp: payload.sdp, 
                receiverId: socket.id,
                roomCode: roomCode
            });
        } catch (error) {
            console.error('❌ Error handling answer:', error);
            socket.emit('error', 'Failed to process answer');
        }
    });

    // Enhanced ICE candidate relay with validation
    socket.on('ice-candidate', (payload) => {
        try {
            if (!payload.candidate) {
                console.error('❌ Invalid ICE candidate payload');
                return;
            }

            const roomCode = userRooms.get(socket.id);
            if (!roomCode) {
                console.error('❌ User not in any room for ICE candidate');
                return;
            }

            const roomInfo = getRoomInfo(roomCode);
            if (!roomInfo) {
                console.error('❌ Room not found for ICE candidate');
                return;
            }

            console.log(`🧊 Relaying ICE candidate from ${socket.id} in room ${roomCode}`);
            
            // Update room activity
            roomInfo.lastActivity = Date.now();
            
            if (payload.target) {
                // Direct target specified
                if (!io.sockets.sockets.get(payload.target)) {
                    console.error('❌ Target user not connected for ICE candidate');
                    return;
                }
                
                io.to(payload.target).emit('ice-candidate', { 
                    candidate: payload.candidate,
                    senderId: socket.id
                });
            } else {
                // Broadcast to room (excluding sender)
                socket.broadcast.to(roomCode).emit('ice-candidate', { 
                    candidate: payload.candidate,
                    senderId: socket.id
                });
            }
        } catch (error) {
            console.error('❌ Error handling ICE candidate:', error);
        }
    });

    // Handle file transfer events (optional - for socket-based fallback)
    socket.on('file-chunk', (payload) => {
        try {
            const roomCode = userRooms.get(socket.id);
            if (!roomCode) return;

            const roomInfo = getRoomInfo(roomCode);
            if (!roomInfo) return;

            // Update room activity
            roomInfo.lastActivity = Date.now();

            if (payload.target && io.sockets.sockets.get(payload.target)) {
                io.to(payload.target).emit('file-chunk', payload);
            } else {
                socket.broadcast.to(roomCode).emit('file-chunk', payload);
            }
        } catch (error) {
            console.error('❌ Error handling file chunk:', error);
        }
    });

    socket.on('file-complete', (payload) => {
        try {
            const roomCode = userRooms.get(socket.id);
            if (!roomCode) return;

            const roomInfo = getRoomInfo(roomCode);
            if (!roomInfo) return;

            // Update room activity
            roomInfo.lastActivity = Date.now();

            if (payload.target && io.sockets.sockets.get(payload.target)) {
                io.to(payload.target).emit('file-complete', payload);
            } else {
                socket.broadcast.to(roomCode).emit('file-complete', payload);
            }
        } catch (error) {
            console.error('❌ Error handling file complete:', error);
        }
    });

    // Heartbeat mechanism
    socket.on('ping', () => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            const roomInfo = getRoomInfo(roomCode);
            if (roomInfo) {
                roomInfo.lastActivity = Date.now();
            }
        }
        socket.emit('pong');
    });

    socket.on('disconnect', (reason) => {
        console.log('❌ User disconnected:', socket.id, 'Reason:', reason);
        
        try {
            // Clean up room if user was in one
            const roomCode = userRooms.get(socket.id);
            if (roomCode) {
                const roomInfo = getRoomInfo(roomCode);
                if (roomInfo) {
                    // Notify the other user in the room
                    const otherUserId = roomInfo.sender === socket.id ? roomInfo.receiver : roomInfo.sender;
                    
                    if (otherUserId && io.sockets.sockets.get(otherUserId)) {
                        io.to(otherUserId).emit('peer-disconnected', { 
                            reason: 'peer-left',
                            userId: socket.id 
                        });
                    }
                    
                    // Remove the room entirely
                    cleanupRoom(roomCode, 'user-disconnected');
                }
            }
        } catch (error) {
            console.error('❌ Error handling disconnect:', error);
        }
    });

    // Handle connection errors
    socket.on('error', (error) => {
        console.error('❌ Socket error for', socket.id, ':', error);
        
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            cleanupRoom(roomCode, 'socket-error');
        }
    });
});

// Enhanced room cleanup - runs every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('🧹 Running room cleanup job...');
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;
  const fiveMinutesInactive = 5 * 60 * 1000;
  
  let cleanedRooms = 0;
  
  for (const [roomCode, roomInfo] of rooms.entries()) {
    const roomAge = now - roomInfo.created;
    const inactiveTime = now - roomInfo.lastActivity;
    
    let shouldClean = false;
    let reason = '';
    
    // Clean if room is older than 30 minutes
    if (roomAge > thirtyMinutes) {
      shouldClean = true;
      reason = 'room-timeout';
    }
    // Clean if room has been inactive for 5 minutes and has no receiver
    else if (inactiveTime > fiveMinutesInactive && !roomInfo.receiver) {
      shouldClean = true;
      reason = 'inactive-no-receiver';
    }
    // Clean if users are no longer connected
    else {
      const senderConnected = roomInfo.sender && io.sockets.sockets.get(roomInfo.sender);
      const receiverConnected = roomInfo.receiver && io.sockets.sockets.get(roomInfo.receiver);
      
      if (!senderConnected && !receiverConnected) {
        shouldClean = true;
        reason = 'all-users-disconnected';
      }
    }
    
    if (shouldClean) {
      cleanupRoom(roomCode, reason);
      cleanedRooms++;
    }
  }
  
  if (cleanedRooms > 0) {
    console.log(`🗑️ Cleaned up ${cleanedRooms} rooms`);
  }
  
  console.log(`📊 Active rooms: ${rooms.size}, Connected users: ${io.sockets.sockets.size}`);
});

// Clean up old uploaded files every hour
cron.schedule('0 * * * *', () => {
  console.log('🧹 Running file cleanup job...');
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) {
      console.error("Could not list the directory.", err);
      return;
    }

    files.forEach((file) => {
      const filePath = path.join(UPLOADS_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err) {
          console.error("Error stating file.", err);
          return;
        }

        const now = new Date().getTime();
        const twentyFourHours = 24 * 60 * 60 * 1000;
        const fileAge = now - new Date(stat.mtime).getTime();

        if (fileAge > twentyFourHours) {
          console.log(`🗑️ Deleting old file: ${file}`);
          fs.unlink(filePath, (err) => {
            if (err) console.error(`Error deleting file: ${file}`, err);
          });
        }
      });
    });
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    activeRooms: rooms.size,
    connectedSockets: io.sockets.sockets.size,
    uptime: process.uptime()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  
  // Close all rooms
  for (const [roomCode] of rooms.entries()) {
    cleanupRoom(roomCode, 'server-shutdown');
  }
  
  // Close server
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`📡 Signaling server running on port ${PORT}`);
  console.log(`🌐 Health check available at /health`);
});