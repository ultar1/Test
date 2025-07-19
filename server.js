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

const logger = pino({ level: 'info' }).child({ level: 'info', stream: 'baileys' });

const DEFAULT_SESSION_ID = 'default_baileys_session';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const activeSessions = new Map();

async function startBaileys(sessionId, authMethod = 'qr', phoneNumber = null, clientSocket) {
    logger.info(`[${sessionId}] Attempting to start Baileys session with method: ${authMethod}`);

    // --- Critical: Check and Clean up Existing Session ---
    let existingSession = activeSessions.get(sessionId);

    if (existingSession && existingSession.sock) {
        if (existingSession.sock.user) { // Already connected/open
            logger.info(`[${sessionId}] Session already open. Emitting status to client.`);
            clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
            return;
        } else if (existingSession.currentAuthMethod === authMethod && existingSession.clientSocket === clientSocket) {
             // If the same client initiated the same method and it's still in progress,
             // just re-emit the current status/QR/pairing code, don't create a new socket.
             logger.info(`[${sessionId}] Same client re-requested same auth method. Re-emitting current status.`);
             if (existingSession.qrData) { // Check if QR data was already generated
                 clientSocket.emit('qr', existingSession.qrData);
                 clientSocket.emit('connection_status', { connection: 'connecting', message: 'Scan QR code' });
             } else if (existingSession.pairingCode) { // Check if pairing code was already generated
                 clientSocket.emit('pairing_code', existingSession.pairingCode);
                 clientSocket.emit('connection_status', { connection: 'connecting', message: 'Enter pairing code' });
             } else {
                 clientSocket.emit('connection_status', { connection: 'connecting', message: 'Generating code...' });
             }
             return;
        } else {
            // A different client or method, or existing socket is just hanging, end it.
            logger.info(`[${sessionId}] Ending previous socket before re-establishing for new request.`);
            try {
                await existingSession.sock.end(new Boom('New authentication request', { statusCode: DisconnectReason.restarting }));
            } catch (e) {
                logger.warn(`[${sessionId}] Error ending previous socket:`, e.message); // Log message, not full error trace
            }
            activeSessions.delete(sessionId);
            existingSession = null; // Clear reference
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

    // Store the new session details
    activeSessions.set(sessionId, {
        sock,
        authState: state,
        saveCreds,
        clientSocket, // Keep a reference to the initiating client socket
        currentAuthMethod: authMethod, // Store the method initiated
        qrData: null, // To store QR data if generated
        pairingCode: null // To store pairing code if generated
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        logger.info(`[${sessionId}] Connection update: ${connection}, isNewLogin: ${isNewLogin}, qr: ${!!qr}`);

        // Get the current session details from the map, important if multiple clients interact
        const currentSession = activeSessions.get(sessionId);
        if (!currentSession || currentSession.sock !== sock) {
            // This update is for an old/stale socket, ignore it
            logger.warn(`[${sessionId}] Ignoring update for stale socket.`);
            return;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            logger.info(`[${sessionId}] Connection closed due to `, lastDisconnect.error);
            // Emit to the client that initiated this specific session if still connected
            currentSession.clientSocket.emit('connection_status', { connection: 'close', reason: lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut ? 'loggedOut' : 'reconnecting' });

            if (!shouldReconnect) {
                logger.info(`[${sessionId}] Logged out. Cleaning up session data.`);
                activeSessions.delete(sessionId);
                fs.rmSync(authFolderPath, { recursive: true, force: true });
            }
            // If it should reconnect, Baileys internally handles some level of reconnection,
            // but for UI, we expect user to re-initiate if they see 'close'.
        } else if (connection === 'open') {
            logger.info(`[${sessionId}] Opened connection! Bot is ready.`);
            currentSession.clientSocket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });

            // ⭐ Send "Hi" message to the bot's own private chat for test
            // Only send if it's a truly new login or first time connect
            // Checking `sock.user` ensures we have the JID.
            if (sock.user && isNewLogin) { // `isNewLogin` is the key for a fresh auth
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

        } else if (connection === 'connecting') {
            if (qr && isNewLogin) { // Only emit QR if a new QR is generated and it's a new login attempt
                qrcode.toDataURL(qr, (err, url) => {
                    if (err) {
                        logger.error(`[${sessionId}] Error generating QR code:`, err);
                        currentSession.clientSocket.emit('error', { message: 'Failed to generate QR code.' });
                        return;
                    }
                    currentSession.qrData = url.split(',')[1]; // Store the QR data
                    currentSession.clientSocket.emit('qr', currentSession.qrData);
                    logger.info(`[${sessionId}] QR code generated and sent to frontend.`);
                    currentSession.clientSocket.emit('connection_status', { connection: 'connecting', message: 'Scan QR code' });
                });
            } else if (update.pairingCode && isNewLogin) { // Only emit pairing code if it's generated for a new login
                logger.info(`[${sessionId}] Pairing Code generated: ${update.pairingCode}`);
                currentSession.pairingCode = update.pairingCode; // Store the pairing code
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
    // and send it to them. This helps in cases where the bot is already running.
    const existingSession = activeSessions.get(DEFAULT_SESSION_ID);
    if (existingSession && existingSession.sock && existingSession.sock.user) {
        socket.emit('connection_status', { connection: 'open', message: 'Bot Connected!' });
    } else if (existingSession && existingSession.sock) {
        // If there's an active socket but not yet open (e.g., waiting for QR)
        socket.emit('connection_status', { connection: 'connecting', message: 'Awaiting QR/Pairing Code Scan' });
        // Re-send existing QR/pairing code if available
        if (existingSession.qrData) {
            socket.emit('qr', existingSession.qrData);
        } else if (existingSession.pairingCode) {
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
            logger.error(`Error starting Baileys for session ${sessionIdToUse}:`, error.message); // Log only message for less verbosity
            socket.emit('error', { message: `Failed to start authentication: ${error.message}` });
        }
    });

    socket.on('disconnect', () => {
        logger.info('User disconnected from the web UI.');
        // We don't automatically close the Baileys session here, as it's persistent.
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser to authenticate your bot.`);
});
