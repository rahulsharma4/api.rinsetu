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
    const { DisconnectReason, makeInMemoryStore } = baileysModule;
    const QRCode = QRCodeModule?.default || QRCodeModule;
    const pino = pinoModule?.default || pinoModule;
    const logger = pino ? pino({ level: 'silent' }) : { level: 'silent' };

    const { state, saveCreds } = await useMongoDBAuthState(baileysModule);

    // Set up in-memory store (handles LID <-> phone JID mapping automatically)
    let waStore = null;
    if (makeInMemoryStore) {
      waStore = makeInMemoryStore({ logger });
    }

    const initSocket = makeWASocket.default || makeWASocket;
    sock = initSocket({
      auth: state,
      printQRInTerminal: true,
      logger,
    });

    // Bind store to socket events so it auto-tracks contacts, chats, etc.
    if (waStore) {
      waStore.bind(sock.ev);
    }

    sock.ev.on('creds.update', saveCreds);

    // Manual LID map as extra fallback (in case store doesn't have it yet)
    const lidToPhoneMap = {};
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.id && c.lid) {
          lidToPhoneMap[c.lid] = c.id;
          console.log(`📱 LID mapped: ${c.lid} -> ${c.id}`);
        }
      }
    });
    sock.ev.on('contacts.update', (updates) => {
      for (const c of updates) {
        if (c.id && c.lid) {
          lidToPhoneMap[c.lid] = c.id;
        }
      }
    });

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

    // Two-Way WhatsApp Bot (Auto-Responder)
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return; // ignore outgoing

      const senderJid = msg.key.remoteJid;
      
      // CRITICAL: Skip group messages - bot only works in direct/private chat
      if (senderJid.endsWith('@g.us')) return;
      
      // Resolve @lid JIDs to actual phone JIDs (WhatsApp multi-device protocol)
      let resolvedJid = senderJid;
      if (senderJid.endsWith('@lid')) {
        // Method 1: Reverse-search waStore.contacts (indexed by phone, contact has .lid field)
        if (waStore?.contacts) {
          for (const [phoneJid, contact] of Object.entries(waStore.contacts)) {
            if (contact?.lid === senderJid || contact?.lid === senderJid.split('@')[0]) {
              resolvedJid = phoneJid;
              break;
            }
          }
        }
        // Method 2: Manual map from contacts.upsert event
        if (resolvedJid === senderJid && lidToPhoneMap[senderJid]) {
          resolvedJid = lidToPhoneMap[senderJid];
        }
        // Method 3: Try sock.contacts if available
        if (resolvedJid === senderJid && sock.contacts) {
          for (const [phoneJid, contact] of Object.entries(sock.contacts)) {
            if (contact?.lid === senderJid) {
              resolvedJid = phoneJid;
              break;
            }
          }
        }
        if (resolvedJid === senderJid) {
          // Still not resolved — store the LID in map for later and ask to retry
          console.warn(`⚠️ @lid not mapped: ${senderJid}`);
          await sock.sendMessage(senderJid, { 
            text: 'नमस्ते! कृपया 15 सेकंड बाद दोबारा "Balance" लिखें।'
          });
          return;
        }
        console.log(`✅ @lid resolved: ${senderJid} -> ${resolvedJid}`);
      }

      
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const incomingText = text.trim().toLowerCase();
      
      if (['balance', 'pay'].includes(incomingText)) {
        try {
          // Extract phone number from resolved JID like: 917221921501@s.whatsapp.net
          let rawId = resolvedJid.split('@')[0];
          rawId = rawId.split(':')[0];
          let digitsOnly = rawId.replace(/\D/g, '');
          if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
            digitsOnly = digitsOnly.slice(2);
          } else if (digitsOnly.length > 10) {
            digitsOnly = digitsOnly.slice(-10);
          }

          const Customer = (await import('../models/Customer.js')).default;
          const Loan = (await import('../models/Loan.js')).default;
          const Installment = (await import('../models/Installment.js')).default;
          
          // Try exact match first, then regex match to handle numbers stored with spaces/dashes
          let customer = await Customer.findOne({ phone: digitsOnly });
          if (!customer) {
            customer = await Customer.findOne({ phone: `+91${digitsOnly}` });
          }
          if (!customer) {
            customer = await Customer.findOne({ phone: { $regex: digitsOnly } });
          }
          // Final fallback: search by last 7 unique digits (handles partial saves)
          if (!customer && digitsOnly.length >= 7) {
            const last7 = digitsOnly.slice(-7);
            customer = await Customer.findOne({ phone: { $regex: last7 + '$' } });
          }
          
          if (!customer) {
            // Send reply to the resolved JID so the message goes to the right person
            await sock.sendMessage(resolvedJid || senderJid, { 
              text: `माफ़ करें, आपका नंबर (${digitsOnly}) हमारे रिकॉर्ड में नहीं है। कृपया अपने रजिस्टर्ड मोबाइल नंबर से संपर्क करें।` 
            });
            return;
          }

          const loans = await Loan.find({ customerId: customer._id, status: { $in: ['active', 'overdue', 'npa'] } });
          
          if (loans.length === 0) {
             await sock.sendMessage(senderJid, { text: `नमस्ते ${customer.name}, आपका कोई भी ऋण/लोन फिलहाल एक्टिव नहीं है।` });
             return;
          }

          let replyText = `नमस्ते *${customer.name}*,\n\n`;
          let totalDue = 0;
          let activePrincipal = 0;
          
          for (const loan of loans) {
            activePrincipal += loan.principalAmount;
            const overdue = await Installment.find({ loanId: loan._id, status: { $in: ['unpaid', 'partially_paid', 'overdue'] }, dueDate: { $lt: new Date() } });
            
            let loanDue = 0;
            overdue.forEach(inst => {
                loanDue += Math.max(0, inst.totalAmount - (inst.amountPaid || 0));
            });
            // Add loan late fees
            loanDue += (loan.lateCharges || 0) - (loan.lateChargesPaid || 0);
            totalDue += loanDue;
          }

          if (totalDue > 0) {
            replyText += `आपकी कुल बकाया/ओवरड्यू राशि: *₹${Math.round(totalDue)}*\n\n`;
            if (incomingText === 'pay') {
               // Generate payment portal link. Assuming frontend is running locally or deployed.
               // We will use a generic placeholder for the frontend domain or relative path if possible, 
               // but typically you'd read process.env.FRONTEND_URL.
               const frontendUrl = process.env.FRONTEND_URL || 'https://rin-setu.vercel.app';
               replyText += `💳 भुगतान करने के लिए इस लिंक पर क्लिक करें:\n👉 ${frontendUrl}/pay/${customer._id}\n\n`;
            } else {
               replyText += `कृपया जल्द से जल्द भुगतान करें। ('pay' लिखकर रिप्लाई करें)\n`;
            }
          } else {
            replyText += `आपकी कोई भी किश्त अभी ओवरड्यू नहीं है। आपका खाता बिल्कुल सही चल रहा है।\n`;
          }

          await sock.sendMessage(senderJid, { text: replyText });

        } catch (botErr) {
          console.error("WhatsApp Bot Error:", botErr);
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
