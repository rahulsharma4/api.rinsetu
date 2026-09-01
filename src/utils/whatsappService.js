import fs from 'fs';
import WASession from '../models/WASession.js';

let sock = null;
let latestQR = null;
let connectionStatus = 'unavailable'; // 'connecting', 'connected', 'qr_ready', 'disconnected', 'unavailable'
let connectedPhone = null;

const IS_LOCAL = true; // Always enable WhatsApp Gateway

async function useMongoDBAuthState(baileysModule) {
  const { initAuthCreds, BufferJSON, proto } = baileysModule;

  const credsDoc = await WASession.findById('creds');
  let creds;
  if (credsDoc && credsDoc.data) {
    creds = JSON.parse(JSON.stringify(credsDoc.data), BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const doc = await WASession.findById(`${type}:${id}`);
              if (doc && doc.data) {
                let value = JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
                if (type === 'app-state-sync-key' && value && proto) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
              }
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}:${id}`;
              if (value) {
                const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
                tasks.push(
                  WASession.findByIdAndUpdate(key, { _id: key, data: serialized }, { upsert: true })
                );
              } else {
                tasks.push(WASession.findByIdAndDelete(key));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      const serializedCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      await WASession.findByIdAndUpdate('creds', { _id: 'creds', data: serializedCreds }, { upsert: true });
    },
  };
}

export async function initWhatsApp() {
  if (sock) return; // Already running or connected

  connectionStatus = 'connecting';
  latestQR = null;
  connectedPhone = null;
  console.log('🔄 Initializing local WhatsApp Gateway (MongoDB Persisted Baileys)...');

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
    const { DisconnectReason } = baileysModule;
    const QRCode = QRCodeModule?.default || QRCodeModule;
    const pino = pinoModule?.default || pinoModule;
    const logger = pino ? pino({ level: 'silent' }) : { level: 'silent' };

    const { state, saveCreds } = await useMongoDBAuthState(baileysModule);

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

  try {
    await WASession.deleteMany({});
    console.log('🗑️ WhatsApp session documents cleared from MongoDB.');
  } catch (err) {
    console.error('Failed to clear WASession from MongoDB:', err);
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
