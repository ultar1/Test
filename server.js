const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const fs = require('fs'); // Node.js File System module

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    is
} = require('@whiskeysockets/baileys'); // Added 'is' import
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

// Set logger level to 'info' to see more details
const logger = pino({ level: 'info' }).child({ level: 'info', stream: 'baileys' });

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Map to store active Baileys sessions
// Each session stores { sock, authState, saveCreds, socket (reference to client socket) }
const activeSessions = new Map();

// Function to start or reconnect a Baileys session
async function startBaileys(sessionId, authMethod = 'qr', phoneNumber = null, clientSocket) {
    logger.info(`[${sessionId}] Attempting to start Baileys session with method: ${authMethod}`);

    // --- Cleanup Existing Session if Any ---
    if (activeSessions.has(sessionId)) {
        const existingSession = activeSessions.get(sessionId);
        if (existingSession.sock && existingSession.sock.user) {
            // Session already open, just confirm status to the requesting client
            logger.info(`[${sessionId}] Session already open. Emitting status.`);
            clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
            return;
        } else if (existingSession.sock) {
            // Socket exists but not open, try to end it cleanly
            logger.info(`[${sessionId}] Closing previous disconnected socket before re-establishing.`);
            try {
                // Use a proper disconnect reason
                await existingSession.sock.end(new Boom('Reconnecting initiated by user', { statusCode: DisconnectReason.restarting }));
            } catch (e) {
                logger.warn(`[${sessionId}] Error ending previous socket:`, e);
            }
            activeSessions.delete(sessionId); // Remove entry to allow fresh state init
        }
    }

    // Define auth folder path
    const authFolderPath = path.join(__dirname, 'auth_info_baileys', sessionId);

    // Ensure the auth folder exists
    if (!fs.existsSync(authFolderPath)) {
        fs.mkdirSync(authFolderPath, { recursive: true });
        logger.info(`[${sessionId}] Created auth folder: ${authFolderPath}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);

    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`[${sessionId}] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: [`Baileys Bot (${sessionId})`, 'Chrome', '10.0.0'],
        // For pairing code, Baileys will automatically request if this is provided
        // and a session isn't immediately found/restored.
        // The phoneNumber should be in the format '91XXXXXXXXXX' (country code + number)
        pairingCode: authMethod === 'pairing' ? phoneNumber : undefined,
    });

    // Store the active session details, including the client socket that initiated it
    activeSessions.set(sessionId, { sock, authState: state, saveCreds, clientSocket });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
        logger.info(`[${sessionId}] Connection update: ${connection}, isNewLogin: ${isNewLogin}, qr: ${!!qr}`);

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            logger.info(`[${sessionId}] Connection closed due to `, lastDisconnect.error);
            clientSocket.emit('connection_status', { connection: 'close', reason: lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut ? 'loggedOut' : 'reconnecting' });

            // If it's a permanent logout, remove session from map and delete auth files
            if (!shouldReconnect) {
                logger.info(`[${sessionId}] Logged out. Cleaning up session data.`);
                activeSessions.delete(sessionId);
                fs.rmSync(authFolderPath, { recursive: true, force: true }); // Delete auth files
            }

            // Only attempt to reconnect if the client explicitly requests it or if it's a temporary disconnect.
            // For this UI, we let the user re-click for a new QR/pairing.
            if (shouldReconnect) {
                logger.info(`[${sessionId}] Temporary disconnect. Bot might try to reconnect automatically.`);
                // You could re-call startBaileys here if you want auto-reconnect without user action
                // But for the specific UI flow, it's better to let the user initiate
            }
        } else if (connection === 'open') {
            logger.info(`[${sessionId}] Opened connection! Bot is ready.`);
            clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });

            // ⭐ Send "Hi" message to a private chat after successful login (first time or reconnect)
            // You might want to get the user's phone number who scanned the QR code.
            // For simplicity, let's assume you know the target JID for testing.
            // Replace '2348012345678@s.whatsapp.net' with a real WhatsApp user's JID
            // The user's own JID is usually `sock.user.id`
            const testTargetJid = sock.user.id; // Send 'Hi' to the bot's own number
            // Or if you want to send to the number that scanned, it's not directly exposed by Baileys on connection
            // You'd typically set up a command for this, or have a pre-configured target.

            // Let's send to the bot's own number (sock.user.id)
            if (testTargetJid) {
                try {
                    await sock.sendMessage(testTargetJid, { text: 'Hello! I am your Baileys bot and I just logged in successfully! 🚀' });
                    logger.info(`[${sessionId}] Sent 'Hello' message to ${testTargetJid}`);
                } catch (e) {
                    logger.error(`[${sessionId}] Failed to send 'Hello' message:`, e);
                }
            }

        } else if (connection === 'connecting') {
            if (qr && isNewLogin) { // Only emit QR if a new QR is generated and it's a new login attempt
                qrcode.toDataURL(qr, (err, url) => {
                    if (err) {
                        logger.error(`[${sessionId}] Error generating QR code:`, err);
                        clientSocket.emit('error', { message: 'Failed to generate QR code.' });
                        return;
                    }
                    clientSocket.emit('qr', url.split(',')[1]);
                    logger.info(`[${sessionId}] QR code generated and sent to frontend.`);
                    clientSocket.emit('connection_status', { connection: 'connecting', message: 'Scan QR code' });
                });
            } else if (update.pairingCode && isNewLogin) { // Only emit pairing code if it's generated for a new login
                logger.info(`[${sessionId}] Pairing Code generated: ${update.pairingCode}`);
                clientSocket.emit('pairing_code', update.pairingCode);
                clientSocket.emit('connection_status', { connection: 'connecting', message: 'Enter pairing code' });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Message handling example (optional)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) { // Ensure it's not a message from self and has content
                    const messageContent = msg.message.extendedTextMessage?.text || msg.message.conversation || '';
                    if (messageContent.toLowerCase().includes('hi bot')) {
                        await sock.sendMessage(msg.key.remoteJid, { text: `Hello ${msg.pushName || 'there'}! How can I help you? 😊` });
                    }
                }
            }
        }
    });
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    logger.info('A user connected to the web UI.');

    // Listen for client requests to start authentication
    socket.on('start_auth', async (data) => {
        const { method, sessionId, phoneNumber } = data;
        const normalizedSessionId = sessionId || 'default_baileys_session'; // Ensure a default if none provided
        logger.info(`Received start_auth request for session: ${normalizedSessionId}, method: ${method}`);

        // Pass the specific socket that made the request
        try {
            await startBaileys(normalizedSessionId, method, phoneNumber, socket);
        } catch (error) {
            logger.error(`Error starting Baileys for session ${normalizedSessionId}:`, error);
            socket.emit('error', { message: `Failed to start authentication: ${error.message}` });
        }
    });

    socket.on('disconnect', () => {
        logger.info('User disconnected from the web UI.');
        // If you had a per-socket Baileys instance, you'd clean it up here.
        // But since we have persistent sessions via activeSessions map,
        // we generally don't disconnect the Baileys bot when a web UI client disconnects.
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser to authenticate your bot.`);
});

