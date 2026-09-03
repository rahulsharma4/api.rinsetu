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
    // Tracks which @lid senders are awaiting phone number input
    const pendingPhoneRequest = new Set();

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return; // ignore outgoing

      const senderJid = msg.key.remoteJid;
      
      // CRITICAL: Skip group messages - bot only works in direct/private chat
      if (senderJid.endsWith('@g.us')) return;
      
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const incomingText = text.trim();

      const incomingLower = incomingText.toLowerCase();
      const isCommand = ['balance', 'pay'].includes(incomingLower);
      const isPendingPhone = pendingPhoneRequest.has(senderJid);

      // --- Handle @lid JID (WhatsApp multi-device protocol v2) ---
      let resolvedJid = senderJid;
      if (senderJid.endsWith('@lid')) {
        // If not a command and not pending, ignore regular chatter from @lid
        if (!isCommand && !isPendingPhone) return;

        const WALidMap = (await import('../models/WALidMap.js')).default;
        
        // STEP 1: Check if we already have a stored mapping in MongoDB
        const existingMap = await WALidMap.findOne({ lid: senderJid });
        if (existingMap) {
          resolvedJid = existingMap.phoneJid;
          console.log(`✅ @lid resolved from DB: ${senderJid} -> ${resolvedJid}`);
        } else if (isPendingPhone) {
          // STEP 2: We previously asked for phone. Is this message a phone number?
          const digits = incomingText.replace(/\D/g, '');
          if (digits.length === 10) {
            // Save this LID → phone mapping permanently
            const phoneJid = `91${digits}@s.whatsapp.net`;
            await WALidMap.create({ lid: senderJid, phoneJid, phone: digits });
            pendingPhoneRequest.delete(senderJid);
            resolvedJid = phoneJid;
            console.log(`✅ @lid saved to DB: ${senderJid} -> ${phoneJid}`);
            // Now continue to process the command (no text to process, tell them to send Balance)
            await sock.sendMessage(senderJid, { text: `✅ आपका नंबर register हो गया! अब "Balance" या "Pay" लिखकर भेजें।` });
            return;
          } else {
            // Not a valid phone, ask again
            await sock.sendMessage(senderJid, { text: 'कृपया सिर्फ अपना 10 अंकों का मोबाइल नंबर भेजें (जैसे: 9876543210)' });
            return;
          }
        } else {
          // STEP 3: First time seeing this LID + it IS a command — ask for phone number
          pendingPhoneRequest.add(senderJid);
          await sock.sendMessage(senderJid, { 
            text: 'नमस्ते! बेहतर सेवा के लिए कृपया अपना 10 अंकों का मोबाइल नंबर भेजें जो आपके ऋण खाते में दर्ज है।\n\n(उदाहरण: 9876543210)'
          });
          return;
        }
      }

      if (isCommand) {

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
            await sock.sendMessage(senderJid, { text: `नमस्ते *${customer.name}* 🙏\n\nआपका कोई भी ऋण/लोन फिलहाल एक्टिव नहीं है।\n\n✅ आपका खाता क्लीयर है।` });
            return;
          }

          const frontendUrl = process.env.FRONTEND_URL || 'https://rin-setu.vercel.app';
          const fmt = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;
          const fmtDate = (d) => d ? new Date(d).toLocaleDateString('hi-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '-';

          let replyText = `🙏 नमस्ते *${customer.name}*,\n`;
          replyText += `━━━━━━━━━━━━━━━━━━━━\n`;

          let grandTotalDue = 0;
          let grandTotalPrincipal = 0;
          let grandTotalPaid = 0;
          const isPayCommand = incomingLower === 'pay';

          for (let i = 0; i < loans.length; i++) {
            const loan = loans[i];
            const loanNum = loans.length > 1 ? ` ${i + 1}` : '';

            // Get all installments for this loan
            const allInst = await Installment.find({ loanId: loan._id }).sort({ dueDate: 1 });
            
            // Overdue installments
            const now = new Date();
            const overdueInst = allInst.filter(inst => 
              ['unpaid', 'partially_paid', 'overdue'].includes(inst.status) && new Date(inst.dueDate) < now
            );
            
            // Next upcoming installment
            const nextInst = allInst.find(inst => 
              ['unpaid', 'partially_paid'].includes(inst.status) && new Date(inst.dueDate) >= now
            );

            let loanDue = 0;
            overdueInst.forEach(inst => {
              loanDue += Math.max(0, (inst.totalAmount || 0) - (inst.amountPaid || 0));
            });
            loanDue += Math.max(0, (loan.lateCharges || 0) - (loan.lateChargesPaid || 0));
            
            const totalPaid = allInst.reduce((s, inst) => s + (inst.amountPaid || 0), 0);
            const totalOutstanding = Math.max(0, (loan.principalAmount || 0) - (loan.paidPrincipal || 0));
            
            grandTotalDue += loanDue;
            grandTotalPrincipal += loan.principalAmount || 0;
            grandTotalPaid += totalPaid;

            if (loans.length > 1) {
              replyText += `\n📋 *लोन${loanNum}* (${loan.remarks || `#${loan._id.toString().slice(-5).toUpperCase()}`})\n`;
            }

            replyText += `💰 मूल राशि: *${fmt(loan.principalAmount)}*\n`;
            replyText += `✅ कुल भुगतान: *${fmt(totalPaid)}*\n`;
            replyText += `📌 शेष मूलधन: *${fmt(totalOutstanding)}*\n`;
            
            if (nextInst) {
              replyText += `📅 अगली किश्त: *${fmt(nextInst.totalAmount - (nextInst.amountPaid || 0))}* on ${fmtDate(nextInst.dueDate)}\n`;
            }
            
            if (loanDue > 0) {
              replyText += `⚠️ ओवरड्यू बकाया: *${fmt(loanDue)}* (${overdueInst.length} किश्त)\n`;
            }
          }

          replyText += `━━━━━━━━━━━━━━━━━━━━\n`;

          if (grandTotalDue > 0) {
            replyText += `\n🚨 *कुल बकाया: ${fmt(grandTotalDue)}*\n`;
            replyText += `कृपया जल्द भुगतान करें।\n`;
            if (isPayCommand) {
              replyText += `\n💳 *ऑनलाइन पेमेंट लिंक:*\n👉 ${frontendUrl}/pay/${customer._id}\n`;
            } else {
              replyText += `\n📲 भुगतान के लिए "Pay" लिखकर भेजें।\n`;
            }
          } else {
            // No overdue amount – give a positive summary and next actions
            replyText += `\n✅ *कोई बकाया नहीं!* 🎉\n`;
            replyText += `आपका कुल मूलधन: *${fmt(grandTotalPrincipal)}*\n`;
            replyText += `कुल भुगतान किया गया: *${fmt(grandTotalPaid)}*\n`;
            const nextInstOverall = await Installment.findOne({ loanId: { $in: loans.map(l => l._id) }, status: { $in: ['unpaid', 'partially_paid'] } }).sort({ dueDate: 1 });
            if (nextInstOverall) {
              const amount = fmt(nextInstOverall.totalAmount - (nextInstOverall.amountPaid || 0));
              const dueDate = fmtDate(nextInstOverall.dueDate);
              replyText += `अगली भुगतान: *${amount}* on ${dueDate}\n`;
            }
            replyText += `\nआप अपना लोन स्टेटमेंट यहाँ देख सकते हैं: ${frontendUrl}/loan/${customer._id}\n`;
            replyText += `📞 यदि कोई प्रश्न हो तो सपोर्ट से संपर्क करें: +91-XXXXXXXXXX\n`;
            if (isPayCommand) {
              replyText += `\n💳 *ऑनलाइन पेमेंट लिंक:*\n👉 ${frontendUrl}/pay/${customer._id}\n`;
            }
          }

          replyText += `\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦`;

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
