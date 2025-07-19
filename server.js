const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const fs = require('fs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

// Set logger level to 'info' to see more details
const logger = pino({ level: 'info' }).child({ level: 'info', stream: 'baileys' });

// Define a single, default session ID
const DEFAULT_SESSION_ID = 'default_baileys_session';

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Map to store active Baileys sessions
const activeSessions = new Map();

async function startBaileys(sessionId, authMethod = 'qr', phoneNumber = null, clientSocket) {
    logger.info(`[${sessionId}] Attempting to start Baileys session with method: ${authMethod}`);

    let existingSession = activeSessions.get(sessionId);

    if (existingSession && existingSession.sock) {
        if (existingSession.sock.user) { // Already connected/open
            logger.info(`[${sessionId}] Session already open. Emitting status to client.`);
            clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
            return;
        } else if (existingSession.currentAuthMethod === authMethod && existingSession.clientSocket === clientSocket) {
             logger.info(`[${sessionId}] Same client re-requested same auth method. Re-emitting current status.`);
             if (existingSession.qrData) {
                 clientSocket.emit('qr', existingSession.qrData);
                 clientSocket.emit('connection_status', { connection: 'connecting', message: 'Scan QR code' });
             } else if (existingSession.pairingCode) {
                 clientSocket.emit('pairing_code', existingSession.pairingCode);
                 clientSocket.emit('connection_status', { connection: 'connecting', message: 'Enter pairing code' });
             } else {
                 clientSocket.emit('connection_status', { connection: 'connecting', message: 'Generating code...' });
             }
             return;
        } else {
            logger.info(`[${sessionId}] Ending previous socket before re-establishing for new request.`);
            try {
                await existingSession.sock.end(new Boom('New authentication request', { statusCode: DisconnectReason.restarting }));
            } catch (e) {
                logger.warn(`[${sessionId}] Error ending previous socket:`, e.message);
            }
            activeSessions.delete(sessionId);
            existingSession = null;
        }
    }

    const authFolderPath = path.join(__dirname, 'auth_info_baileys', sessionId);
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

    activeSessions.set(sessionId, {
        sock,
        authState: state,
        saveCreds,
        clientSocket,
        currentAuthMethod: authMethod,
        qrData: null,
        pairingCode: null
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        logger.info(`[${sessionId}] Connection update: ${connection || 'undefined'}, isNewLogin: ${isNewLogin}, qr: ${!!qr}`);

        const currentSession = activeSessions.get(sessionId);
        if (!currentSession || currentSession.sock !== sock) {
            logger.warn(`[${sessionId}] Ignoring update for stale socket.`);
            return;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            logger.info(`[${sessionId}] Connection closed due to `, lastDisconnect.error);
            currentSession.clientSocket.emit('connection_status', { connection: 'close', reason: lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut ? 'loggedOut' : 'reconnecting' });

            if (!shouldReconnect) {
                logger.info(`[${sessionId}] Logged out. Cleaning up session data.`);
                activeSessions.delete(sessionId);
                fs.rmSync(authFolderPath, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            logger.info(`[${sessionId}] Opened connection! Bot is ready.`);
            currentSession.clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });

            if (sock.user && isNewLogin) {
                const testTargetJid = sock.user.id;
                try {
                    await sock.sendMessage(testTargetJid, { text: 'Hello! I am your Baileys bot and I just logged in successfully! My JID is ' + testTargetJid });
                    logger.info(`[${sessionId}] Sent 'Hello' message to ${testTargetJid} after new login.`);
                } catch (e) {
                    logger.error(`[${sessionId}] Failed to send 'Hello' message:`, e);
                }
            } else if (sock.user && !isNewLogin) {
                logger.info(`[${sessionId}] Reconnected without new login. Not sending 'Hello' message.`);
            }
        } else if (connection === 'connecting' || connection === undefined) { // <-- CRITICAL CHANGE HERE
            // If connection is 'connecting' OR undefined (as seen in logs)
            if (qr && isNewLogin) {
                qrcode.toDataURL(qr, (err, url) => {
                    if (err) {
                        logger.error(`[${sessionId}] Error generating QR code:`, err);
                        currentSession.clientSocket.emit('error', { message: 'Failed to generate QR code.' });
                        return;
                    }
                    currentSession.qrData = url.split(',')[1];
                    currentSession.clientSocket.emit('qr', currentSession.qrData);
                    logger.info(`[${sessionId}] QR code generated and sent to frontend.`);
                    currentSession.clientSocket.emit('connection_status', { connection: 'connecting', message: 'Scan QR code' });
                });
            } else if (update.pairingCode && isNewLogin) {
                logger.info(`[${sessionId}] Pairing Code generated: ${update.pairingCode}`);
                currentSession.pairingCode = update.pairingCode;
                currentSession.clientSocket.emit('pairing_code', currentSession.pairingCode);
                currentSession.clientSocket.emit('connection_status', { connection: 'connecting', message: 'Enter pairing code' });
            } else {
                 // For other 'connecting' states, e.g., reconnecting after a brief drop
                 currentSession.clientSocket.emit('connection_status', { connection: 'connecting', message: 'Connecting...' });
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

io.on('connection', (socket) => {
    logger.info('A user connected to the web UI.');

    // When a client connects, immediately check status of the DEFAULT_SESSION_ID
    const existingSession = activeSessions.get(DEFAULT_SESSION_ID);
    if (existingSession && existingSession.sock && existingSession.sock.user) {
        socket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
    } else if (existingSession && existingSession.sock) {
        // If there's an active socket but not yet open (e.g., waiting for QR)
        socket.emit('connection_status', { connection: 'connecting', message: 'Awaiting QR/Pairing Code Scan' });
        if (existingSession.qrData) { // Re-send stored QR data
            socket.emit('qr', existingSession.qrData);
        } else if (existingSession.pairingCode) { // Re-send stored pairing code
            socket.emit('pairing_code', existingSession.pairingCode);
        }
    }


    socket.on('start_auth', async (data) => {
        const { method, phoneNumber } = data;
        const sessionIdToUse = DEFAULT_SESSION_ID;
        logger.info(`Received start_auth request for method: ${method} for fixed session: ${sessionIdToUse}`);

        try {
            await startBaileys(sessionIdToUse, method, phoneNumber, socket);
        } catch (error) {
            logger.error(`Error starting Baileys for session ${sessionIdToUse}:`, error.message);
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
