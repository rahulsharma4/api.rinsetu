import fs from 'fs';

let sock = null;
let latestQR = null;
let connectionStatus = 'unavailable'; // 'connecting', 'connected', 'qr_ready', 'disconnected', 'unavailable'
let connectedPhone = null;

// Only run on local server — Baileys requires a persistent process & QR scan
const IS_LOCAL = process.env.NODE_ENV !== 'production' || process.env.ENABLE_LOCAL_WA === 'true';

export async function initWhatsApp() {
  if (!IS_LOCAL) {
    console.log('ℹ️ WhatsApp local gateway is disabled in production. Use Cloud API mode instead.');
    connectionStatus = 'unavailable';
    return;
  }

  if (sock) return; // Already running or connected

  connectionStatus = 'connecting';
  latestQR = null;
  connectedPhone = null;
  console.log('🔄 Initializing local WhatsApp Gateway (Baileys)...');

  try {
    // Dynamically import so missing package doesn't crash entire server
    const [baileysModule, QRCodeModule, pinoModule] = await Promise.all([
      import('@whiskeysockets/baileys').catch(() => null),
      import('qrcode').catch(() => null),
      import('pino').catch(() => null),
    ]);

    if (!baileysModule) {
      console.warn('⚠️ @whiskeysockets/baileys not installed. Local WhatsApp gateway unavailable.');
      connectionStatus = 'unavailable';
      return;
    }

    const makeWASocket = baileysModule.default;
    const { useMultiFileAuthState, DisconnectReason } = baileysModule;
    const QRCode = QRCodeModule?.default || QRCodeModule;
    const pino = pinoModule?.default || pinoModule;
    const logger = pino ? pino({ level: 'silent' }) : { level: 'silent' };
    const authFolder = process.env.WA_SESSION_PATH || './session_auth_info';

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const initSocket = makeWASocket.default || makeWASocket;
    sock = initSocket({
      auth: state,
      printQRInTerminal: true,
      logger,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'qr_ready';
        if (QRCode) {
          try {
            latestQR = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error('Failed to generate QR data URL:', err);
          }
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ WhatsApp connection closed. Reconnect:', shouldReconnect);
        sock = null;
        latestQR = null;
        connectionStatus = 'disconnected';
        connectedPhone = null;

        if (shouldReconnect) {
          setTimeout(initWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        latestQR = null;
        const userJid = sock.user?.id || '';
        connectedPhone = userJid.split(':')[0] || userJid.split('@')[0];
        console.log(`✅ WhatsApp Gateway connected as +${connectedPhone}!`);
        
        // Auto scan active installments & flush queued messages when WhatsApp connects
        try {
          const { autoQueuePeriodicNotifications } = await import('./notificationCompiler.js');
          await autoQueuePeriodicNotifications();
        } catch (fErr) {
          console.error('Failed to auto-scan & flush notifications on WA connect:', fErr.message);
        }
      }
    });
  } catch (err) {
    console.warn('⚠️ WhatsApp Gateway init failed (non-critical):', err.message);
    connectionStatus = 'disconnected';
    sock = null;
  }
}

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    phone: connectedPhone,
    qr: latestQR,
  };
}

export async function logoutWhatsApp() {
  try {
    if (sock) {
      await sock.logout();
      sock.end();
    }
  } catch (err) {
    console.warn('Socket logout warning:', err.message);
  }
  sock = null;
  latestQR = null;
  connectionStatus = 'disconnected';
  connectedPhone = null;

  const authFolder = process.env.WA_SESSION_PATH || './session_auth_info';
  if (fs.existsSync(authFolder)) {
    try {
      fs.rmSync(authFolder, { recursive: true, force: true });
      console.log('🗑️ WhatsApp session folder cleared.');
    } catch (err) {
      console.error('Failed to delete auth folder:', err);
    }
  }

  if (IS_LOCAL) setTimeout(initWhatsApp, 1000);
}

export async function sendWhatsAppMessage(toPhone, text) {
  if (connectionStatus !== 'connected' || !sock) {
    console.warn(`⚠️ Cannot send WhatsApp. Gateway status: ${connectionStatus}`);
    return false;
  }

  try {
    let cleanPhone = toPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = `91${cleanPhone}`;
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error('Failed to send WhatsApp message via Gateway:', err);
    return false;
  }
}
