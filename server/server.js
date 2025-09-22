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
  // IMPORTANT: Replace 'http://localhost:3001' with your server's public URL when you deploy
  const fileUrl = `http://localhost:3001/files/${req.file.filename}`;
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

        const now = new Date().getTime(); // Fixed: was "aDate"
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
    origin: "https://code-drop-theta.vercel.app", // <-- Your Vercel URL
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 3001;

// Store room information
const rooms = new Map();

// --- Fixed Signaling Logic ---
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    // Store the socket's current room
    socket.currentRoom = null;

    socket.on('create-room', () => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(roomCode);
        socket.currentRoom = roomCode;
        
        // Store room info
        rooms.set(roomCode, {
          sender: socket.id,
          receiver: null,
          created: Date.now()
        });
        
        socket.emit('room-created', roomCode);
        console.log(`🚀 Room created: ${roomCode} by ${socket.id}`);
    });

    socket.on('join-room', (roomCode) => {
        const room = io.sockets.adapter.rooms.get(roomCode);
        const roomInfo = rooms.get(roomCode);
        
        if (room && room.size === 1 && roomInfo && !roomInfo.receiver) {
            socket.join(roomCode);
            socket.currentRoom = roomCode;
            
            // Update room info
            roomInfo.receiver = socket.id;
            
            // Notify the sender that receiver has joined
            io.to(roomInfo.sender).emit('receiver-joined', { 
              receiverId: socket.id,
              roomCode: roomCode 
            });
            
            console.log(`👋 User ${socket.id} joined room ${roomCode}`);
            socket.emit('room-joined', roomCode);
        } else {
            socket.emit('error', 'Invalid or full room code');
            console.log(`❌ Failed to join room ${roomCode}: Invalid or full`);
        }
    });

    // Relay WebRTC signaling messages with proper room context
    socket.on('offer', (payload) => {
        console.log(`📤 Relaying offer from ${socket.id} to ${payload.target}`);
        io.to(payload.target).emit('offer', { 
          sdp: payload.sdp, 
          senderId: socket.id,
          roomCode: socket.currentRoom
        });
    });

    socket.on('answer', (payload) => {
        console.log(`📤 Relaying answer from ${socket.id} to ${payload.target}`);
        io.to(payload.target).emit('answer', { 
          sdp: payload.sdp, 
          receiverId: socket.id,
          roomCode: socket.currentRoom
        });
    });

    // Fixed ICE candidate relay - now properly targets the other peer
    socket.on('ice-candidate', (payload) => {
        console.log(`🧊 Relaying ICE candidate from ${socket.id}`);
        
        if (payload.target) {
          // If target is specified, send directly to that peer
          io.to(payload.target).emit('ice-candidate', { 
            candidate: payload.candidate,
            senderId: socket.id
          });
        } else if (socket.currentRoom) {
          // Otherwise broadcast to room (excluding sender)
          socket.broadcast.to(socket.currentRoom).emit('ice-candidate', { 
            candidate: payload.candidate,
            senderId: socket.id
          });
        }
    });

    // Handle file transfer events
    socket.on('file-chunk', (payload) => {
        if (payload.target) {
          io.to(payload.target).emit('file-chunk', payload);
        } else if (socket.currentRoom) {
          socket.broadcast.to(socket.currentRoom).emit('file-chunk', payload);
        }
    });

    socket.on('file-complete', (payload) => {
        if (payload.target) {
          io.to(payload.target).emit('file-complete', payload);
        } else if (socket.currentRoom) {
          socket.broadcast.to(socket.currentRoom).emit('file-complete', payload);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
        
        // Clean up room if user was in one
        if (socket.currentRoom) {
          const roomInfo = rooms.get(socket.currentRoom);
          if (roomInfo) {
            // Notify the other user in the room
            const otherUserId = roomInfo.sender === socket.id ? roomInfo.receiver : roomInfo.sender;
            if (otherUserId) {
              io.to(otherUserId).emit('peer-disconnected');
            }
            
            // Remove the room
            rooms.delete(socket.currentRoom);
          }
        }
    });
});

// Clean up old rooms every 10 minutes
cron.schedule('*/10 * * * *', () => {
  console.log('🧹 Cleaning up old rooms...');
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [roomCode, roomInfo] of rooms.entries()) {
    if (now - roomInfo.created > oneHour) {
      console.log(`🗑️ Removing old room: ${roomCode}`);
      rooms.delete(roomCode);
    }
  }
});

server.listen(PORT, () => {
  console.log(`📡 Signaling server running on http://localhost:${PORT}`);
});