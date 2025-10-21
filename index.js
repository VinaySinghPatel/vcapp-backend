import express from 'express';
const app = express();
import connectToMongoDb from './db.js';
import cors from 'cors';
import {createServer} from "http";
import {Server} from "socket.io";
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
dotenv.config();


const port = process.env.PORT || 3000;

connectToMongoDb();

app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
}));

app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({status: 'ok'});
});

app.get('/', (req, res) => {
    res.send('Server is started');
});

const httpServer = createServer(app);
const io = new Server(httpServer,{
    cors: {
        origin: process.env.SOCKET_CORS_ORIGIN || "http://localhost:5173",
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true,
    },
});

httpServer.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// Rooms and participants logic
const rooms = new Map();

function getParticipants(roomId){
    const sessionIds = rooms.get(roomId) || new Set();
    return Array.from(sessionIds);
}

function joinRoom(socket, roomId){
    const sessionId = socket.id;
    if(!rooms.has(roomId)){
        rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(sessionId);
    socket.join(roomId);
    console.log(`[room ${roomId}] ${sessionId} joined. Total: ${rooms.get(roomId).size}`);
}

// ✅ FIXED: Consistent parameter order (roomId, socketId)
function leaveRoom(roomId, socketId){
    const set = rooms.get(roomId);
    if(!set) return;
    
    set.delete(socketId);
    console.log(`[room ${roomId}] ${socketId} left. Remaining: ${set.size}`);
    
    if(set.size === 0){
        rooms.delete(roomId);
        console.log(`[room ${roomId}] Room deleted (empty)`);
    }
}

// IO SETUP AND CONNECTION LOGIC
io.on('connection', (socket) => {
    console.log(`Socket connected ${socket.id}`);

    const MAX_PARTICIPANTS = 2;

    socket.on('create-room', (ack) => {
        const roomId = randomUUID();
        joinRoom(socket, roomId);
        const others = getParticipants(roomId).filter(id => id !== socket.id);
        if (typeof ack === 'function') {
            ack({ roomId, selfId: socket.id, participants: others });
        }
        console.log(`[room ${roomId}] created by ${socket.id}`);
    });

    socket.on('join-room', ({ roomId }, ack) => {
        if (!roomId) return ack?.({ error: 'roomId required' });

        const current = getParticipants(roomId);
        
        // ✅ Check if user is already in room (reconnection)
        if (current.includes(socket.id)) {
            console.log(`[room ${roomId}] ${socket.id} already in room`);
            const others = current.filter(id => id !== socket.id);
            return ack?.({ ok: true, selfId: socket.id, participants: others });
        }

        if (current.length >= MAX_PARTICIPANTS) {
            console.log(`[room ${roomId}] Room full. Current: ${current.length}`);
            return ack?.({ error: 'room is full' });
        }

        // Get existing participants BEFORE joining
        const existingParticipants = getParticipants(roomId);
        
        // Join the room
        joinRoom(socket, roomId);
        
        // Get updated participant list (excluding self)
        const others = getParticipants(roomId).filter(id => id !== socket.id);
        
        // Send acknowledgment with participant list
        ack?.({ ok: true, selfId: socket.id, participants: others });
        
        console.log(`[room ${roomId}] ${socket.id} joined. Existing: ${existingParticipants.length}, Others: ${others.length}`);
        
        // Notify existing users about new user ONLY (let them initiate offer)
        if (existingParticipants.length > 0) {
            console.log(`[room ${roomId}] Notifying existing users about new user ${socket.id}`);
            socket.to(roomId).emit('user-joined', { socketId: socket.id });
        }
    });

    socket.on('leave-room', ({ roomId }) => {
        leaveRoom(roomId, socket.id);  // ✅ FIXED: Correct parameter order
        socket.leave(roomId);
        socket.to(roomId).emit('user-left', { socketId: socket.id });
        console.log(`[room ${roomId}] ${socket.id} left`);
    });

    // ✅ NEW: Handle request for offer from existing participant
    socket.on('request-offer', ({ to }) => {
        if (!to) return;
        console.log(`[room] ${socket.id} requesting offer from ${to}`);
        io.to(to).emit('user-joined', { socketId: socket.id });
    });

    socket.on('offer', ({ to, sdp }) => {
        if (!to || !sdp) {
            console.log(`[WebRTC] Invalid offer - to: ${to}, sdp: ${!!sdp}`);
            return;
        }
        console.log(`[WebRTC] 📤 Relaying offer from ${socket.id} to ${to}`);
        io.to(to).emit('offer', { from: socket.id, sdp });
    });

    socket.on('answer', ({ to, sdp }) => {
        if (!to || !sdp) {
            console.log(`[WebRTC] Invalid answer - to: ${to}, sdp: ${!!sdp}`);
            return;
        }
        console.log(`[WebRTC] 📤 Relaying answer from ${socket.id} to ${to}`);
        io.to(to).emit('answer', { from: socket.id, sdp });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
        if (!to || !candidate) {
            console.log(`[WebRTC] Invalid ICE candidate - to: ${to}, candidate: ${!!candidate}`);
            return;
        }
        console.log(`[WebRTC] 📤 Relaying ICE from ${socket.id} to ${to}`);
        io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    });

    socket.on('disconnecting', () => {
        console.log(`Socket disconnecting: ${socket.id}`);
        for (const roomId of socket.rooms) {
            if (roomId === socket.id) continue;
            socket.to(roomId).emit('user-left', { socketId: socket.id });
            leaveRoom(roomId, socket.id);  // ✅ FIXED: Correct parameter order
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
    });
});
