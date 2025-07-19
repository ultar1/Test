const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

const logger = pino({ level: 'silent' }); // Set to 'info' for more logs

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Map to store active Baileys sessions
const activeSessions = new Map(); // sessionId -> { sock, authState, saveCreds }

// Function to start or reconnect a Baileys session
async function startBaileys(sessionId, authMethod = 'qr', phoneNumber = null, socket) {
    logger.info(`Attempting to start Baileys session for: ${sessionId} with method: ${authMethod}`);

    // If a session already exists and is open, just emit status
    if (activeSessions.has(sessionId) && activeSessions.get(sessionId).sock && activeSessions.get(sessionId).sock.user) {
        logger.info(`Session ${sessionId} already open.`);
        socket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
        return;
    }

    // Clean up previous disconnected session if it exists
    if (activeSessions.has(sessionId) && activeSessions.get(sessionId).sock) {
        logger.info(`Closing previous socket for session ${sessionId} before re-establishing.`);
        try {
            activeSessions.get(sessionId).sock.end(new Boom('Reconnecting', { statusCode: DisconnectReason.restarting }));
        } catch (e) {
            logger.warn(`Error ending previous socket for ${sessionId}:`, e);
        }
        activeSessions.delete(sessionId);
    }

    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_baileys/${sessionId}`);

    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false, // Important: always false for web UI
        auth: state,
        browser: [`Baileys Bot (${sessionId})`, 'Chrome', '10.0.0'],
        // Specify if using pairing code initially
        pairingCode: authMethod === 'pairing' ? phoneNumber : undefined,
    });

    activeSessions.set(sessionId, { sock, authState: state, saveCreds }); // Store the active session details

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, is  } = update; // 'is' is 'isNewLogin' property for pairing code, not 'is'

        if (qr && connection !== 'open' && authMethod === 'qr') {
            qrcode.toDataURL(qr, (err, url) => {
                if (err) {
                    logger.error('Error generating QR code:', err);
                    socket.emit('error', { message: 'Failed to generate QR code.' });
                    return;
                }
                socket.emit('qr', url.split(',')[1]);
                logger.info(`QR code generated and sent for session: ${sessionId}`);
                socket.emit('connection_status', { connection: 'connecting', message: 'Scan QR code' });
            });
        } else if (update.pairingCode && connection !== 'open' && authMethod === 'pairing') {
            logger.info(`Pairing Code generated for ${sessionId}: ${update.pairingCode}`);
            socket.emit('pairing_code', update.pairingCode);
            socket.emit('connection_status', { connection: 'connecting', message: 'Enter pairing code' });
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            logger.info(`Connection closed for session ${sessionId} due to `, lastDisconnect.error);
            socket.emit('connection_status', { connection: 'close', reason: lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut ? 'loggedOut' : 'reconnecting' });

            // Clear session from map if logged out or permanent error
            if (!shouldReconnect) {
                activeSessions.delete(sessionId);
                logger.info(`Session ${sessionId} permanently disconnected.`);
            }

            // Only attempt to reconnect if the client is still waiting or if it was a temporary disconnect
            // The frontend now handles re-initiating the auth flow
            // If shouldReconnect is true, we could automatically call startBaileys again here,
            // but for a user-driven auth page, it's better to let the user re-click
            // to get a new QR/pairing code.
            // For now, if shouldReconnect, log it, but don't auto-call startBaileys.
            if (shouldReconnect) {
                logger.info(`Session ${sessionId} needs to reconnect, but waiting for user action.`);
            }
        } else if (connection === 'open') {
            logger.info(`Opened connection for session: ${sessionId}!`);
            socket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
            // You can optionally remove the QR/pairing code info after successful connection
            // to keep the display clean, or redirect the user.
        } else {
            socket.emit('connection_status', { connection, message: `Status: ${connection}` });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Message handling example (optional)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.text.toLowerCase() === 'hello') {
                    await sock.sendMessage(msg.key.remoteJid, { text: `Hi there! I am your Baileys bot for session ${sessionId}.` });
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
        logger.info(`Received start_auth request for session: ${sessionId}, method: ${method}`);

        try {
            await startBaileys(sessionId, method, phoneNumber, socket);
        } catch (error) {
            logger.error(`Error starting Baileys for session ${sessionId}:`, error);
            socket.emit('error', { message: `Failed to start authentication: ${error.message}` });
        }
    });

    socket.on('disconnect', () => {
        logger.info('User disconnected from the web UI.');
        // Consider if you want to disconnect the Baileys session when the user's browser closes.
        // For persistent bots, you usually don't. The `activeSessions` map keeps them alive.
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser to authenticate your bot.`);
});
