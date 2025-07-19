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
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

const logger = pino({ level: 'info' }).child({ level: 'info', stream: 'baileys' });

// Define a single, default session ID
const DEFAULT_SESSION_ID = 'default_baileys_session'; // Changed this from constant to const for consistency

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Map to store active Baileys sessions
// We'll still use a map, but it will likely only hold one entry for DEFAULT_SESSION_ID
const activeSessions = new Map();

// Function to start or reconnect a Baileys session
// sessionId parameter is now expected to be DEFAULT_SESSION_ID
async function startBaileys(sessionId, authMethod = 'qr', phoneNumber = null, clientSocket) {
    logger.info(`[${sessionId}] Attempting to start Baileys session with method: ${authMethod}`);

    // --- Cleanup Existing Session if Any ---
    if (activeSessions.has(sessionId)) {
        const existingSession = activeSessions.get(sessionId);
        if (existingSession.sock && existingSession.sock.user) {
            logger.info(`[${sessionId}] Session already open. Emitting status.`);
            clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
            return;
        } else if (existingSession.sock) {
            logger.info(`[${sessionId}] Closing previous disconnected socket before re-establishing.`);
            try {
                await existingSession.sock.end(new Boom('Reconnecting initiated by user', { statusCode: DisconnectReason.restarting }));
            } catch (e) {
                logger.warn(`[${sessionId}] Error ending previous socket:`, e);
            }
            activeSessions.delete(sessionId);
        }
    }

    // Define auth folder path using the fixed session ID
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
        pairingCode: authMethod === 'pairing' ? phoneNumber : undefined,
    });

    activeSessions.set(sessionId, { sock, authState: state, saveCreds, clientSocket });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update; // Removed 'is' as it was incorrect, replaced with isNewLogin
        logger.info(`[${sessionId}] Connection update: ${connection}, isNewLogin: ${isNewLogin}, qr: ${!!qr}`);

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            logger.info(`[${sessionId}] Connection closed due to `, lastDisconnect.error);
            clientSocket.emit('connection_status', { connection: 'close', reason: lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut ? 'loggedOut' : 'reconnecting' });

            if (!shouldReconnect) {
                logger.info(`[${sessionId}] Logged out. Cleaning up session data.`);
                activeSessions.delete(sessionId);
                fs.rmSync(authFolderPath, { recursive: true, force: true });
            }
            // Frontend will handle user re-initiation if needed
        } else if (connection === 'open') {
            logger.info(`[${sessionId}] Opened connection! Bot is ready.`);
            clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });

            // ⭐ Send "Hi" message to the bot's own private chat for test
            const testTargetJid = sock.user.id; // Send 'Hi' to the bot's own number
            if (testTargetJid) {
                try {
                    // To prevent sending 'Hi' on every reconnect (only on initial login after QR/pairing)
                    // You would typically store a flag in a database. For simple persistent file,
                    // we can check if it's a truly new login.
                    // This is heuristic, for production, better store state in a database.
                    if (isNewLogin) { // This property helps distinguish initial scans
                         await sock.sendMessage(testTargetJid, { text: 'Hello! I am your Baileys bot and I just logged in successfully! My JID is ' + testTargetJid + ' 🚀' });
                         logger.info(`[${sessionId}] Sent 'Hello' message to ${testTargetJid} after new login.`);
                    } else {
                         logger.info(`[${sessionId}] Reconnected without new login. Not sending 'Hello' message.`);
                    }

                } catch (e) {
                    logger.error(`[${sessionId}] Failed to send 'Hello' message:`, e);
                }
            }
        } else if (connection === 'connecting') {
            if (qr && isNewLogin) {
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
            } else if (update.pairingCode && isNewLogin) {
                logger.info(`[${sessionId}] Pairing Code generated: ${update.pairingCode}`);
                clientSocket.emit('pairing_code', update.pairingCode);
                clientSocket.emit('connection_status', { connection: 'connecting', message: 'Enter pairing code' });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
                    const messageContent = msg.message.extendedTextMessage?.text || msg.message.conversation || '';
                    if (messageContent.toLowerCase().includes('hi bot')) {
                        await sock.sendMessage(msg.key.remoteJid, { text: `Hello ${msg.pushName || 'there'}! How can I help you? :)` });
                    }
                }
            }
        }
    });
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    logger.info('A user connected to the web UI.');

    socket.on('start_auth', async (data) => {
        const { method, phoneNumber } = data; // sessionId is no longer passed from frontend
        // Use the hardcoded default session ID
        const sessionIdToUse = DEFAULT_SESSION_ID;
        logger.info(`Received start_auth request for method: ${method} for fixed session: ${sessionIdToUse}`);

        try {
            await startBaileys(sessionIdToUse, method, phoneNumber, socket);
        } catch (error) {
            logger.error(`Error starting Baileys for session ${sessionIdToUse}:`, error);
            socket.emit('error', { message: `Failed to start authentication: ${error.message}` });
        }
    });

    socket.on('disconnect', () => {
        logger.info('User disconnected from the web UI.');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser to authenticate your bot.`);
});
