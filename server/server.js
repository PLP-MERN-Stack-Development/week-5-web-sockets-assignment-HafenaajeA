// server.js - Main server file for Socket.io chat application

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const jwt = require('jsonwebtoken');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store connected users and messages
const users = {};
const messages = [];
const typingUsers = {};
const rooms = { global: { name: 'global', users: [] } }; // roomName: { name, users }
const messageReactions = {}; // messageId: { userId: reaction }

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// Simple username-based login route (returns JWT)
app.post('/api/login', (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'Username is required' });
  }
  // In a real app, check for duplicate usernames, etc.
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, username });
});

// Middleware for Socket.io authentication
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication error: Token required'));
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.username = payload.username;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  // Add user to global chat room by default
  socket.join('global');
  rooms['global'].users.push(socket.id);
  users[socket.id] = { username: socket.username, id: socket.id, online: true, currentRoom: 'global' };
  io.emit('user_list', Object.values(users));
  io.emit('user_joined', { username: socket.username, id: socket.id });
  io.emit('online_status', { id: socket.id, online: true });
  io.emit('room_list', Object.keys(rooms));
  console.log(`${socket.username} joined the chat`);

  // Send a welcome event to client on connection
  socket.emit('welcome', 'Connected to Socket.io server');

  // Send chat history to the newly connected user
  socket.emit('chat_history', messages);

  // Room management
  socket.on('create_room', (roomName) => {
    if (!rooms[roomName]) {
      rooms[roomName] = { name: roomName, users: [] };
      io.emit('room_list', Object.keys(rooms));
    }
  });

  socket.on('join_room', (roomName) => {
    if (!rooms[roomName]) return;
    // Leave current room
    const prevRoom = users[socket.id]?.currentRoom;
    if (prevRoom && rooms[prevRoom]) {
      socket.leave(prevRoom);
      rooms[prevRoom].users = rooms[prevRoom].users.filter(id => id !== socket.id);
    }
    // Join new room
    socket.join(roomName);
    rooms[roomName].users.push(socket.id);
    users[socket.id].currentRoom = roomName;
    socket.emit('joined_room', roomName);
    io.to(roomName).emit('room_users', rooms[roomName].users.map(id => users[id]));
  });

  socket.on('leave_room', (roomName) => {
    if (!rooms[roomName]) return;
    socket.leave(roomName);
    rooms[roomName].users = rooms[roomName].users.filter(id => id !== socket.id);
    users[socket.id].currentRoom = 'global';
    socket.join('global');
    rooms['global'].users.push(socket.id);
    socket.emit('joined_room', 'global');
    io.to('global').emit('room_users', rooms['global'].users.map(id => users[id]));
  });

  // Handle chat messages (room-aware)
  socket.on('send_message', (messageData) => {
    const room = users[socket.id]?.currentRoom || 'global';
    const message = {
      ...messageData,
      id: Date.now(),
      sender: socket.username,
      senderId: socket.id,
      room,
      timestamp: new Date().toISOString(),
      file: messageData.file || null, // file/image support
      readBy: [socket.id], // sender has read
      reactions: {},
    };
    messages.push(message);
    if (messages.length > 100) messages.shift();
    io.to(room).emit('receive_message', message);
  });

  // File/image sharing (base64 or URL)
  socket.on('send_file', ({ file, fileName, room }) => {
    const message = {
      id: Date.now(),
      sender: socket.username,
      senderId: socket.id,
      room: room || users[socket.id]?.currentRoom || 'global',
      timestamp: new Date().toISOString(),
      file: { data: file, name: fileName },
      readBy: [socket.id],
      reactions: {},
    };
    messages.push(message);
    if (messages.length > 100) messages.shift();
    io.to(message.room).emit('receive_message', message);
  });

  // Private messaging by username
  socket.on('private_message', ({ toUsername, message, file }) => {
    const toSocketId = Object.keys(users).find(id => users[id].username === toUsername);
    if (!toSocketId) return;
    const messageData = {
      id: Date.now(),
      sender: socket.username,
      senderId: socket.id,
      receiver: toUsername,
      receiverId: toSocketId,
      message,
      timestamp: new Date().toISOString(),
      isPrivate: true,
      file: file || null,
      readBy: [socket.id],
      reactions: {},
    };
    socket.to(toSocketId).emit('private_message', messageData);
    socket.emit('private_message', messageData);
  });

  // Read receipts
  socket.on('message_read', (messageId) => {
    const msg = messages.find(m => m.id === messageId);
    if (msg && !msg.readBy.includes(socket.id)) {
      msg.readBy.push(socket.id);
      io.to(msg.room || 'global').emit('message_read', { messageId, userId: socket.id });
    }
  });

  // Message reactions
  socket.on('react_message', ({ messageId, reaction }) => {
    const msg = messages.find(m => m.id === messageId);
    if (msg) {
      msg.reactions[socket.id] = reaction;
      io.to(msg.room || 'global').emit('message_reaction', { messageId, userId: socket.id, reaction });
    }
  });

  // Handle typing indicator
  socket.on('typing', (isTyping) => {
    if (users[socket.id]) {
      const username = users[socket.id].username;

      if (isTyping) {
        typingUsers[socket.id] = username;
      } else {
        delete typingUsers[socket.id];
      }

      io.to('global').emit('typing_users', Object.values(typingUsers));
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    // Remove from rooms
    Object.values(rooms).forEach(room => {
      room.users = room.users.filter(id => id !== socket.id);
    });
    if (users[socket.id]) {
      const { username } = users[socket.id];
      io.emit('user_left', { username, id: socket.id });
      io.emit('online_status', { id: socket.id, online: false });
      console.log(`${username} left the chat`);
    }

    delete users[socket.id];
    delete typingUsers[socket.id];

    io.emit('user_list', Object.values(users));
    io.emit('typing_users', Object.values(typingUsers));
  });
});

// API routes
app.get('/api/messages', (req, res) => {
  res.json(messages);
});

app.get('/api/users', (req, res) => {
  // Add online/offline status
  res.json(Object.values(users));
});

// Root route
app.get('/', (req, res) => {
  res.send('Socket.io Chat Server is running');
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, server, io };