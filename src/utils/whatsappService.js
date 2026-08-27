import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const authFolder = './session_auth_info';

let sock = null;
let latestQR = null;
let connectionStatus = 'disconnected'; // 'connecting', 'connected', 'qr_ready', 'disconnected'
let connectedPhone = null;

export async function initWhatsApp() {
  if (sock) return; // Already running or connected
  
  connectionStatus = 'connecting';
  latestQR = null;
  connectedPhone = null;
  console.log('🔄 Initializing local WhatsApp Gateway (Baileys)...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    const initSocket = makeWASocket.default || makeWASocket;
    sock = initSocket({
      auth: state,
      printQRInTerminal: true,
      logger
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        connectionStatus = 'qr_ready';
        try {
          latestQR = await QRCode.toDataURL(qr);
        } catch (err) {
          console.error('Failed to generate QR data URL:', err);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ WhatsApp connection closed. Reconnect code:', shouldReconnect);
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
        console.log(`✅ WhatsApp Gateway connected successfully as +${connectedPhone}!`);
      }
    });

  } catch (err) {
    console.error('Failed to initialize Baileys WASocket:', err);
    connectionStatus = 'disconnected';
    sock = null;
  }
}

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    phone: connectedPhone,
    qr: latestQR
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

  // Clear directory
  if (fs.existsSync(authFolder)) {
    try {
      fs.rmSync(authFolder, { recursive: true, force: true });
      console.log('🗑️ Local WhatsApp session folder cleared.');
    } catch (err) {
      console.error('Failed to delete auth folder:', err);
    }
  }

  // Re-init connection to generate fresh QR
  setTimeout(initWhatsApp, 1000);
}

export async function sendWhatsAppMessage(toPhone, text) {
  if (connectionStatus !== 'connected' || !sock) {
    console.error(`⚠️ Cannot send WhatsApp message. Gateway status: ${connectionStatus}`);
    return false;
  }

  try {
    let cleanPhone = toPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = `91${cleanPhone}`;
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;
    
    console.log(`Sending WhatsApp message to ${jid}: ${text.substring(0, 40)}...`);
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error('Failed to send WhatsApp message via local Gateway:', err);
    return false;
  }
}
