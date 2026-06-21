const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

// Baileys imports
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// Proxy agents
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;

// ==================== DATA STORES ====================
let accounts = {};          // { id: { sock, phone, status, warmup, proxy, ... } }
let proxies = [];           // [{ id, raw, status, type, host, port, auth }]
let logs = [];              // Activity logs
let config = {              // Admin config
    typingDelay: 3,
    onlineDuration: 30,
    offlineDuration: 10,
    msgLimit: 200,
    warmupDays: 7,
    blockMinDelay: 3,
    blockMaxDelay: 10,
    blockCycles: 50,
    accountCooldown: 2,
    proxyRotation: 6,
    presenceEnabled: true
};

let blockOperations = {};   // Active block operations

// Logger - set to silent to avoid detection patterns
const logger = pino({ level: 'silent' });

// ==================== ANTI-BAN: BROWSER FINGERPRINT POOL ====================
// Realistic browser fingerprints to rotate - mimics real WhatsApp Web users
const BROWSER_FINGERPRINTS = [
    ['Windows', 'Chrome', '122.0.6261.112'],
    ['Windows', 'Chrome', '123.0.6312.86'],
    ['Windows', 'Chrome', '124.0.6367.91'],
    ['Windows', 'Edge', '122.0.2365.92'],
    ['Windows', 'Edge', '123.0.2420.81'],
    ['macOS', 'Chrome', '122.0.6261.112'],
    ['macOS', 'Chrome', '123.0.6312.86'],
    ['macOS', 'Safari', '17.4'],
    ['macOS', 'Safari', '17.3.1'],
    ['Linux', 'Chrome', '122.0.6261.112'],
    ['Linux', 'Firefox', '124.0'],
    ['Ubuntu', 'Chrome', '123.0.6312.86'],
];

function getRandomBrowserFingerprint() {
    const fp = BROWSER_FINGERPRINTS[Math.floor(Math.random() * BROWSER_FINGERPRINTS.length)];
    return Browsers.appropriate(fp[1]); // Returns proper browser tuple
}

// More realistic custom browser config
function getCustomBrowser() {
    const browsers = [
        ['Ubuntu', 'Chrome', '122.0.6261.112'],
        ['Windows', 'Chrome', '123.0.6312.86'],
        ['macOS', 'Chrome', '122.0.6261.112'],
        ['Linux', 'Firefox', '124.0'],
    ];
    return browsers[Math.floor(Math.random() * browsers.length)];
}

// ==================== ANTI-BAN: HUMAN BEHAVIOR UTILITIES ====================

// Gaussian random - more natural than uniform random
function gaussianRandom(mean, stdDev) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.round(z * stdDev + mean);
}

// Human-like delay with Gaussian distribution
function getHumanDelay(minMs, maxMs) {
    const mean = (minMs + maxMs) / 2;
    const stdDev = (maxMs - minMs) / 4;
    let delay = gaussianRandom(mean, stdDev);
    // Clamp to range
    delay = Math.max(minMs, Math.min(maxMs, delay));
    // Add micro-variations (humans aren't perfectly consistent)
    delay += Math.random() * 500 - 250;
    return Math.max(500, Math.round(delay));
}

// Sleep with human-like variation
function humanSleep(baseMs) {
    const variation = baseMs * 0.3; // 30% variation
    const actualDelay = baseMs + (Math.random() * variation * 2 - variation);
    return new Promise(resolve => setTimeout(resolve, Math.max(100, actualDelay)));
}

// Standard sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Random delay between min and max seconds
function getRandomDelay(minSec, maxSec) {
    return getHumanDelay(minSec * 1000, maxSec * 1000);
}

// ==================== HELPER FUNCTIONS ====================

function addLog(type, message) {
    const entry = {
        time: new Date().toLocaleTimeString('en-US', { hour12: false }),
        date: new Date().toLocaleDateString(),
        timestamp: Date.now(),
        type,
        message
    };
    logs.unshift(entry);
    if (logs.length > 1000) logs = logs.slice(0, 1000);
    return entry;
}

function parseProxy(raw) {
    raw = raw.trim();
    if (!raw) return null;
    
    let type = 'http';
    let host, port, username, password;
    
    // Check for protocol prefix
    if (raw.startsWith('socks5://') || raw.startsWith('socks4://')) {
        type = 'socks5';
        raw = raw.replace(/^socks[45]:\/\//, '');
    } else if (raw.startsWith('http://')) {
        type = 'http';
        raw = raw.replace(/^http:\/\//, '');
    } else if (raw.startsWith('https://')) {
        type = 'https';
        raw = raw.replace(/^https:\/\//, '');
    }
    
    // user:pass@host:port OR host:port:user:pass OR host:port
    if (raw.includes('@')) {
        const [auth, hostPort] = raw.split('@');
        [username, password] = auth.split(':');
        [host, port] = hostPort.split(':');
    } else {
        const parts = raw.split(':');
        if (parts.length === 4) {
            [host, port, username, password] = parts;
        } else if (parts.length === 2) {
            [host, port] = parts;
        } else {
            return null;
        }
    }
    
    return { type, host, port: parseInt(port), username, password };
}

function createProxyAgent(proxyData) {
    if (!proxyData) return null;
    
    const { type, host, port, username, password } = proxyData;
    let url;
    
    if (username && password) {
        url = `${type}://${username}:${password}@${host}:${port}`;
    } else {
        url = `${type}://${host}:${port}`;
    }
    
    if (type === 'socks5' || type === 'socks4') {
        return new SocksProxyAgent(url);
    } else if (type === 'https') {
        return new HttpsProxyAgent(url);
    } else {
        return new HttpProxyAgent(url);
    }
}

function formatJid(phone) {
    phone = phone.replace(/[^0-9]/g, '');
    return `${phone}@s.whatsapp.net`;
}

// ==================== ANTI-BAN: WARM-UP SYSTEM ====================
// Tracks account age and limits activity for new accounts

function getWarmupMultiplier(warmupDay, totalWarmupDays) {
    // Day 1: 10% capacity, gradually increases to 100%
    if (warmupDay >= totalWarmupDays) return 1.0;
    const progress = warmupDay / totalWarmupDays;
    // Exponential growth curve
    return Math.min(1.0, 0.1 * Math.pow(10, progress));
}

function getDailyLimit(warmupDay, baseLimit, totalWarmupDays) {
    const multiplier = getWarmupMultiplier(warmupDay, totalWarmupDays);
    return Math.floor(baseLimit * multiplier);
}

// ==================== ACCOUNT MANAGEMENT ====================

// Create socket with anti-ban configurations
function createAntibanSocket(state, version, agent, fetchAgent) {
    const browserConfig = getCustomBrowser();
    
    return makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        browser: browserConfig,
        logger,
        agent,
        fetchAgent,
        
        // Connection settings - realistic timeouts
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000 + Math.floor(Math.random() * 10000), // 25-35s variation
        
        // CRITICAL: Don't mark online immediately (looks like a bot)
        markOnlineOnConnect: false,
        
        // Sync settings
        syncFullHistory: false, // Don't request full history (suspicious for new connections)
        
        // Message retry settings
        retryRequestDelayMs: 2000 + Math.floor(Math.random() * 3000), // 2-5s
        
        // Fire internal events
        emitOwnEvents: true,
        
        // Generate high-quality message IDs
        generateHighQualityLinkPreview: false, // Disable to reduce API calls
        
        // Patch presence to be more natural
        patchMessageBeforeSending: (message) => {
            // Add slight randomization to message timestamps
            return message;
        }
    });
}

// Connect with a specific proxy — returns result
async function attemptConnection(id, phone, proxyRaw) {
    const authFolder = path.join(__dirname, 'auth_sessions', id);
    
    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    // Parse and create proxy agent if provided
    let agent = null;
    let fetchAgent = null;
    if (proxyRaw) {
        const proxyData = parseProxy(proxyRaw);
        if (proxyData) {
            try {
                agent = createProxyAgent(proxyData);
                fetchAgent = createProxyAgent(proxyData);
            } catch (err) {
                addLog('danger', `Proxy agent creation failed for ${proxyRaw}: ${err.message}`);
                return { success: false, error: 'proxy_failed' };
            }
        } else {
            addLog('danger', `Failed to parse proxy: ${proxyRaw}`);
            return { success: false, error: 'proxy_parse_failed' };
        }
    }
    
    return new Promise(async (resolve) => {
        let resolved = false;
        let sock;
        
        // Timeout — if no connection in 45 seconds, proxy is dead
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                addLog('danger', `Connection timeout with proxy: ${proxyRaw || 'No proxy'}`);
                try { sock.end(); } catch (e) {}
                resolve({ success: false, error: 'timeout' });
            }
        }, 45000);
        
        try {
            // Use anti-ban socket configuration
            sock = createAntibanSocket(state, version, agent, fetchAgent);
            
            // Connection events
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === 'close' && !resolved) {
                    clearTimeout(timeout);
                    resolved = true;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    addLog('warn', `Connection closed during pairing (code: ${statusCode}) with proxy: ${proxyRaw || 'No proxy'}`);
                    resolve({ success: false, error: 'connection_closed' });
                } else if (connection === 'open' && accounts[id]) {
                    accounts[id].status = 'online';
                    accounts[id].lastActive = new Date().toISOString();
                    addLog('info', `Account ${phone} connected successfully!`);
                    
                    // ANTI-BAN: Delayed presence update (humans don't go online instantly)
                    setTimeout(async () => {
                        try {
                            if (accounts[id] && accounts[id].sock) {
                                await accounts[id].sock.sendPresenceUpdate('available');
                            }
                        } catch (e) {}
                    }, 5000 + Math.random() * 10000); // 5-15 seconds delay
                }
            });
            
            sock.ev.on('creds.update', saveCreds);
            
            // Request pairing code if not registered
            if (!sock.authState.creds.registered) {
                try {
                    // Wait a moment for socket to stabilize (human-like)
                    await humanSleep(3000);
                    
                    if (resolved) return;
                    
                    const code = await sock.requestPairingCode(phone);
                    clearTimeout(timeout);
                    
                    if (!resolved) {
                        resolved = true;
                        
                        // Store account with this working connection
                        accounts[id] = {
                            id,
                            phone,
                            sock,
                            status: 'connecting',
                            warmupDay: 1,
                            warmupStarted: Date.now(),
                            proxy: proxyRaw,
                            messagestoday: 0,
                            lastActive: new Date().toISOString(),
                            pairingCode: code,
                            browserFingerprint: getCustomBrowser() // Store fingerprint for consistency
                        };
                        
                        // Set up reconnection handler for after pairing
                        sock.ev.on('connection.update', async (update) => {
                            const { connection, lastDisconnect } = update;
                            if (connection === 'close' && accounts[id]) {
                                const statusCode = lastDisconnect?.error?.output?.statusCode;
                                accounts[id].status = 'offline';
                                addLog('warn', `Account ${phone} disconnected: ${statusCode}`);
                                
                                // Classify disconnect reason
                                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                                                       statusCode !== 401 && 
                                                       statusCode !== 403;
                                
                                if (shouldReconnect) {
                                    // Human-like reconnect delay (not instant)
                                    const reconnectDelay = 5000 + Math.random() * 10000;
                                    setTimeout(() => {
                                        if (accounts[id]) {
                                            addLog('info', `Reconnecting ${phone}...`);
                                            reconnectAccount(id, phone, proxyRaw);
                                        }
                                    }, reconnectDelay);
                                } else {
                                    addLog('danger', `Account ${phone} logged out / banned (code: ${statusCode})`);
                                    accounts[id].status = 'banned';
                                }
                            } else if (connection === 'open' && accounts[id]) {
                                accounts[id].status = 'online';
                                accounts[id].lastActive = new Date().toISOString();
                                
                                // Delayed presence after reconnect
                                setTimeout(async () => {
                                    try {
                                        if (accounts[id]?.sock && config.presenceEnabled) {
                                            await accounts[id].sock.sendPresenceUpdate('available');
                                        }
                                    } catch (e) {}
                                }, 3000 + Math.random() * 7000);
                            }
                        });
                        
                        addLog('info', `Pairing code for ${phone}: ${code}`);
                        resolve({ success: true, pairingCode: code, sock });
                    }
                } catch (err) {
                    clearTimeout(timeout);
                    if (!resolved) {
                        resolved = true;
                        try { sock.end(); } catch (e) {}
                        addLog('danger', `Pairing code request failed with proxy ${proxyRaw || 'No proxy'}: ${err.message}`);
                        resolve({ success: false, error: err.message });
                    }
                }
            } else {
                // Already registered
                clearTimeout(timeout);
                if (!resolved) {
                    resolved = true;
                    accounts[id] = {
                        id, phone, sock,
                        status: 'online',
                        warmupDay: Math.floor((Date.now() - (state.creds.registered || Date.now())) / (24 * 60 * 60 * 1000)) + 1,
                        warmupStarted: state.creds.registered || Date.now(),
                        proxy: proxyRaw,
                        messagestoday: 0,
                        lastActive: new Date().toISOString(),
                        pairingCode: null
                    };
                    addLog('info', `Account ${phone} already registered, reconnected.`);
                    
                    // Delayed presence
                    setTimeout(async () => {
                        try {
                            if (accounts[id]?.sock) {
                                await accounts[id].sock.sendPresenceUpdate('available');
                            }
                        } catch (e) {}
                    }, 3000 + Math.random() * 5000);
                    
                    resolve({ success: true, pairingCode: null });
                }
            }
        } catch (err) {
            clearTimeout(timeout);
            if (!resolved) {
                resolved = true;
                addLog('danger', `Socket creation failed with proxy ${proxyRaw || 'No proxy'}: ${err.message}`);
                resolve({ success: false, error: err.message });
            }
        }
    });
}

// Reconnect existing account with same fingerprint
async function reconnectAccount(id, phone, proxyRaw) {
    const authFolder = path.join(__dirname, 'auth_sessions', id);
    
    if (!fs.existsSync(authFolder)) {
        addLog('danger', `Auth folder not found for ${phone}`);
        return;
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    let agent = null;
    let fetchAgent = null;
    if (proxyRaw) {
        const proxyData = parseProxy(proxyRaw);
        if (proxyData) {
            agent = createProxyAgent(proxyData);
            fetchAgent = createProxyAgent(proxyData);
        }
    }
    
    // Use the same browser fingerprint if stored, else generate new
    const browserConfig = accounts[id]?.browserFingerprint || getCustomBrowser();
    
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        browser: browserConfig,
        logger,
        agent,
        fetchAgent,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000 + Math.floor(Math.random() * 10000),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        emitOwnEvents: true,
    });
    
    if (accounts[id]) {
        accounts[id].sock = sock;
    }
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && accounts[id]) {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            accounts[id].status = 'offline';
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                                   statusCode !== 401 && 
                                   statusCode !== 403;
            
            if (shouldReconnect) {
                const delay = 5000 + Math.random() * 15000;
                setTimeout(() => {
                    if (accounts[id]) reconnectAccount(id, phone, proxyRaw);
                }, delay);
            } else {
                accounts[id].status = 'banned';
                addLog('danger', `Account ${phone} permanently disconnected (code: ${statusCode})`);
            }
        } else if (connection === 'open' && accounts[id]) {
            accounts[id].status = 'online';
            accounts[id].lastActive = new Date().toISOString();
            addLog('info', `Account ${phone} reconnected!`);
            
            // Delayed presence update
            setTimeout(async () => {
                try {
                    if (accounts[id]?.sock && config.presenceEnabled) {
                        await accounts[id].sock.sendPresenceUpdate('available');
                    }
                } catch (e) {}
            }, 3000 + Math.random() * 7000);
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// Main connect function — tries proxies until pairing code is generated
async function connectAccount(id, phone) {
    addLog('info', `Starting connection for ${phone} — trying proxies with anti-ban measures...`);
    
    // Get all alive proxies
    let aliveProxies = proxies.filter(p => p.status === 'alive');
    
    // If no proxies loaded, try without proxy
    if (aliveProxies.length === 0) {
        addLog('warn', `No proxies available, connecting ${phone} without proxy...`);
        const result = await attemptConnection(id, phone, null);
        return result;
    }
    
    // Try each alive proxy until pairing code is generated
    let attempt = 0;
    
    while (aliveProxies.length > 0) {
        const proxy = aliveProxies[0];
        attempt++;
        
        addLog('info', `[Attempt ${attempt}] Trying proxy: ${proxy.raw.substring(0, 40)}... for ${phone}`);
        
        const result = await attemptConnection(id, phone, proxy.raw);
        
        if (result.success) {
            addLog('info', `SUCCESS! ${phone} paired using proxy: ${proxy.raw.substring(0, 40)}...`);
            
            // Start human presence simulation for this account
            startPresenceSimulation(id);
            
            return result;
        }
        
        // Failed — mark proxy as dead and delete it
        addLog('danger', `Proxy FAILED: ${proxy.raw.substring(0, 40)}... — Removing...`);
        
        const proxyIndex = proxies.findIndex(p => p.id === proxy.id);
        if (proxyIndex !== -1) {
            proxies.splice(proxyIndex, 1);
        }
        
        aliveProxies.shift();
        
        // Clean up auth folder for fresh retry
        const authFolder = path.join(__dirname, 'auth_sessions', id);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true });
        }
        
        addLog('info', `Remaining alive proxies: ${aliveProxies.length}`);
        
        // Human-like delay before next attempt
        await humanSleep(3000);
    }
    
    // All proxies exhausted — try without proxy as last resort
    addLog('warn', `All proxies exhausted! Trying ${phone} without proxy...`);
    const lastResort = await attemptConnection(id, phone, null);
    
    if (lastResort.success) {
        startPresenceSimulation(id);
    } else {
        addLog('danger', `FAILED to pair ${phone} — all connection attempts failed`);
    }
    
    return lastResort;
}

async function disconnectAccount(id) {
    if (accounts[id]) {
        // Stop presence simulation
        if (accounts[id].presenceInterval) {
            clearInterval(accounts[id].presenceInterval);
        }
        
        if (accounts[id].sock) {
            try {
                // Send offline presence before disconnect (human-like)
                await accounts[id].sock.sendPresenceUpdate('unavailable');
                await sleep(1000);
                await accounts[id].sock.logout();
            } catch (e) {}
            try { accounts[id].sock.end(); } catch (e) {}
        }
        delete accounts[id];
        addLog('warn', `Account ${id} disconnected and removed`);
        return true;
    }
    return false;
}

// ==================== ANTI-BAN: PRESENCE SIMULATION ====================
// Simulates human-like online/offline patterns

function startPresenceSimulation(accId) {
    if (!config.presenceEnabled) return;
    if (!accounts[accId]) return;
    
    // Clear any existing interval
    if (accounts[accId].presenceInterval) {
        clearInterval(accounts[accId].presenceInterval);
    }
    
    const simulatePresence = async () => {
        const account = accounts[accId];
        if (!account || account.status !== 'online' || !account.sock) return;
        
        try {
            // Go online
            await account.sock.sendPresenceUpdate('available');
            addLog('info', `[Presence] ${account.phone} → Online`);
            
            // Schedule going offline after random duration
            const onlineDuration = config.onlineDuration * 60 * 1000 * (0.7 + Math.random() * 0.6);
            
            setTimeout(async () => {
                try {
                    if (accounts[accId]?.sock && accounts[accId].status === 'online') {
                        await accounts[accId].sock.sendPresenceUpdate('unavailable');
                        addLog('info', `[Presence] ${account.phone} → Offline`);
                    }
                } catch (e) {}
            }, onlineDuration);
            
        } catch (e) {
            // Silently fail - presence errors are not critical
        }
    };
    
    // Run presence cycle at intervals
    const cycleTime = (config.onlineDuration + config.offlineDuration) * 60 * 1000;
    accounts[accId].presenceInterval = setInterval(simulatePresence, cycleTime);
    
    // Start first cycle after a delay
    setTimeout(simulatePresence, 5000 + Math.random() * 10000);
}

// ==================== BLOCK ENGINE ====================

// ANTI-BAN: Simulate typing before action (humans type/think before blocking)
async function simulateThinkingBeforeAction(sock, jid) {
    try {
        // Random chance to "view" the chat first
        if (Math.random() > 0.3) {
            await sock.sendPresenceUpdate('available');
            await humanSleep(1000);
        }
        
        // Sometimes simulate typing (as if writing a message but then blocking instead)
        if (Math.random() > 0.7) {
            await sock.sendPresenceUpdate('composing', jid);
            await humanSleep(500 + Math.random() * 1500);
            await sock.sendPresenceUpdate('paused', jid);
            await humanSleep(500);
        }
    } catch (e) {
        // Silently fail - these are optional human-like behaviors
    }
}

// Report contact — sends report signal to WhatsApp with specific reason
async function reportContact(sock, jid, phone, targetPhone, reason = 'spam') {
    try {
        await sock.query({
            tag: 'iq',
            attrs: {
                to: '@s.whatsapp.net',
                type: 'set',
                xmlns: 'w:report',
            },
            content: [
                {
                    tag: 'report',
                    attrs: { jid: jid },
                    content: [
                        {
                            tag: 'reason',
                            attrs: {},
                            content: Buffer.from(reason)
                        }
                    ]
                }
            ]
        });
        return { success: true, reason };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function executeBlockCycle(operationId, targetPhone, accountIds, reportEnabled, reasons, rotateReasons) {
    const operation = blockOperations[operationId];
    if (!operation) return;
    
    const jid = formatJid(targetPhone);
    const totalCycles = config.blockCycles;
    const reportReasons = (reasons && reasons.length > 0) ? reasons : ['spam'];
    
    addLog('danger', `Strike started on ${targetPhone} | ${accountIds.length} accounts | ${totalCycles} cycles | Report: ${reportEnabled ? 'ON' : 'OFF'} | Reasons: ${reportReasons.join(', ')}`);
    
    for (let cycle = 0; cycle < totalCycles; cycle++) {
        if (!blockOperations[operationId] || blockOperations[operationId].aborted) {
            addLog('warn', `Block operation aborted at cycle ${cycle}`);
            break;
        }
        
        operation.currentCycle = cycle + 1;
        operation.action = 'blocking';
        
        // Shuffle account order each cycle (more natural)
        const shuffledAccounts = [...accountIds].sort(() => Math.random() - 0.5);
        
        // Block (+ Report) on all accounts
        for (const accId of shuffledAccounts) {
            if (!accounts[accId] || accounts[accId].status !== 'online') continue;
            
            // Check warmup - skip if account is too new
            const warmupDay = accounts[accId].warmupDay || 1;
            if (warmupDay < 3) {
                addLog('warn', `Skipping ${accounts[accId].phone} - still in warmup (Day ${warmupDay})`);
                continue;
            }
            
            try {
                // ANTI-BAN: Simulate human thinking before action
                await simulateThinkingBeforeAction(accounts[accId].sock, jid);
                
                // Report first if enabled
                if (reportEnabled) {
                    await humanSleep(500); // Small pause before report
                    
                    // Pick reason — rotate or fixed
                    let reason;
                    if (rotateReasons && reportReasons.length > 1) {
                        const accIndex = shuffledAccounts.indexOf(accId);
                        reason = reportReasons[accIndex % reportReasons.length];
                    } else {
                        reason = reportReasons[0];
                    }
                    
                    const reportResult = await reportContact(accounts[accId].sock, jid, accounts[accId].phone, targetPhone, reason);
                    if (reportResult.success) {
                        operation.logs.push({
                            time: new Date().toLocaleTimeString(),
                            message: `REPORTED [${reason.toUpperCase()}] on ${accounts[accId].phone}`,
                            type: 'report'
                        });
                        addLog('block', `Reported [${reason}] ${targetPhone} on ${accounts[accId].phone} (Cycle ${cycle + 1})`);
                    } else {
                        operation.logs.push({
                            time: new Date().toLocaleTimeString(),
                            message: `REPORT FAILED on ${accounts[accId].phone}: ${reportResult.error}`,
                            type: 'error'
                        });
                    }
                    
                    // Human-like delay between report and block
                    await humanSleep(1500);
                }
                
                // Block
                await accounts[accId].sock.updateBlockStatus(jid, 'block');
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `BLOCKED on ${accounts[accId].phone}`,
                    type: 'success'
                });
                addLog('block', `Blocked ${targetPhone} on ${accounts[accId].phone} (Cycle ${cycle + 1})`);
                
            } catch (err) {
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `FAILED on ${accounts[accId].phone}: ${err.message}`,
                    type: 'error'
                });
                addLog('danger', `Block failed on ${accounts[accId].phone}: ${err.message}`);
            }
            
            // ANTI-BAN: Human-like cooldown between accounts with Gaussian distribution
            const cooldown = getHumanDelay(
                config.accountCooldown * 1000,
                config.accountCooldown * 2000
            );
            await sleep(cooldown);
        }
        
        // Random delay before unblock (human thinking time)
        const delay1 = getRandomDelay(config.blockMinDelay, config.blockMaxDelay);
        addLog('info', `Waiting ${Math.round(delay1/1000)}s before unblock phase...`);
        await sleep(delay1);
        
        if (!blockOperations[operationId] || blockOperations[operationId].aborted) break;
        
        operation.action = 'unblocking';
        
        // Unblock on all accounts (different order for naturalness)
        const unblockOrder = [...accountIds].sort(() => Math.random() - 0.5);
        
        for (const accId of unblockOrder) {
            if (!accounts[accId] || accounts[accId].status !== 'online') continue;
            
            const warmupDay = accounts[accId].warmupDay || 1;
            if (warmupDay < 3) continue;
            
            try {
                // Small pre-action pause
                await humanSleep(300);
                
                await accounts[accId].sock.updateBlockStatus(jid, 'unblock');
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `UNBLOCKED on ${accounts[accId].phone}`,
                    type: 'success'
                });
                addLog('block', `Unblocked ${targetPhone} on ${accounts[accId].phone} (Cycle ${cycle + 1})`);
            } catch (err) {
                operation.logs.push({
                    time: new Date().toLocaleTimeString(),
                    message: `FAILED to unblock on ${accounts[accId].phone}: ${err.message}`,
                    type: 'error'
                });
            }
            
            const cooldown = getHumanDelay(
                config.accountCooldown * 1000,
                config.accountCooldown * 2000
            );
            await sleep(cooldown);
        }
        
        operation.blocksCompleted = (cycle + 1) * 2 * accountIds.length;
        
        // Random delay before next cycle
        const delay2 = getRandomDelay(config.blockMinDelay, config.blockMaxDelay);
        addLog('info', `Cycle ${cycle + 1} complete. Waiting ${Math.round(delay2/1000)}s before next cycle...`);
        await sleep(delay2);
    }
    
    operation.status = 'complete';
    operation.action = 'complete';
    addLog('info', `Block operation completed on ${targetPhone}. Total cycles: ${operation.currentCycle}`);
}

// ==================== WARM-UP TRACKER ====================

// Update warm-up day for all accounts every minute
setInterval(() => {
    const now = Date.now();
    Object.values(accounts).forEach(acc => {
        if (acc.warmupStarted) {
            const daysPassed = Math.floor((now - acc.warmupStarted) / (24 * 60 * 60 * 1000));
            acc.warmupDay = Math.min(daysPassed + 1, config.warmupDays + 7); // Cap at warmup + 7
        }
    });
}, 60000);

// ==================== API ENDPOINTS ====================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/accounts', (req, res) => {
    const accountList = Object.values(accounts).map(acc => ({
        id: acc.id,
        phone: acc.phone,
        status: acc.status,
        warmupDay: acc.warmupDay,
        proxy: acc.proxy ? acc.proxy.substring(0, 30) + '...' : 'None',
        messagestoday: acc.messagestoday,
        lastActive: acc.lastActive,
        pairingCode: acc.pairingCode
    }));
    res.json(accountList);
});

app.post('/api/accounts', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    
    const id = uuidv4();
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    addLog('info', `Adding account ${cleanPhone} with anti-ban measures...`);
    
    const result = await connectAccount(id, cleanPhone);
    
    if (result.success) {
        res.json({
            success: true,
            id,
            phone: cleanPhone,
            pairingCode: result.pairingCode,
            proxyUsed: accounts[id] ? accounts[id].proxy : null
        });
    } else {
        const authFolder = path.join(__dirname, 'auth_sessions', id);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true });
        }
        res.status(500).json({ success: false, error: result.error });
    }
});

app.post('/api/accounts/:id/toggle', (req, res) => {
    const { id } = req.params;
    if (!accounts[id]) return res.status(404).json({ error: 'Account not found' });
    
    const acc = accounts[id];
    if (acc.status === 'online') {
        acc.status = 'paused';
        if (acc.presenceInterval) clearInterval(acc.presenceInterval);
        addLog('warn', `Account ${acc.phone} paused`);
    } else if (acc.status === 'paused') {
        acc.status = 'online';
        startPresenceSimulation(id);
        addLog('info', `Account ${acc.phone} resumed`);
    }
    
    res.json({ success: true, status: acc.status });
});

app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const phone = accounts[id]?.phone;
    const result = await disconnectAccount(id);
    
    if (result) {
        const authFolder = path.join(__dirname, 'auth_sessions', id);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true });
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Account not found' });
    }
});

// ==================== PROXY ENDPOINTS ====================

app.get('/api/proxies', (req, res) => {
    res.json(proxies);
});

app.post('/api/proxies', (req, res) => {
    const { proxyList } = req.body;
    if (!proxyList) return res.status(400).json({ error: 'Proxy list required' });
    
    const lines = proxyList.split('\n').filter(l => l.trim());
    
    let loadedCount = 0;
    let skippedCount = 0;
    
    const allParsed = lines.map((raw, i) => {
        const parsed = parseProxy(raw);
        if (parsed) {
            loadedCount++;
            return {
                id: i,
                raw: raw.trim(),
                status: 'alive',
                ...parsed
            };
        } else {
            skippedCount++;
            addLog('warn', `Skipped unparseable proxy: ${raw.trim().substring(0, 40)}...`);
            return null;
        }
    }).filter(p => p !== null);
    
    proxies = allParsed;
    
    addLog('info', `Loaded ${loadedCount} valid proxies | Skipped ${skippedCount} invalid`);
    res.json({ success: true, count: loadedCount, skipped: skippedCount });
});

// ==================== BLOCK ENGINE ENDPOINTS ====================

app.post('/api/block/start', async (req, res) => {
    const { target, report, attackMode, reasons, timingMode, rotateReasons, batchSize, staggerInterval } = req.body;
    if (!target) return res.status(400).json({ error: 'Target number required' });
    
    const onlineAccounts = Object.values(accounts).filter(a => a.status === 'online');
    if (onlineAccounts.length === 0) {
        return res.status(400).json({ error: 'No online accounts available' });
    }
    
    // Filter out accounts still in warmup (first 3 days)
    const readyAccounts = onlineAccounts.filter(a => (a.warmupDay || 1) >= 3);
    if (readyAccounts.length === 0) {
        return res.status(400).json({ error: 'All accounts still in warmup period (minimum 3 days required)' });
    }
    
    const reportEnabled = report === true;
    const operationId = uuidv4();
    const accountIds = readyAccounts.map(a => a.id);
    
    blockOperations[operationId] = {
        id: operationId,
        target,
        report: reportEnabled,
        status: 'running',
        action: 'starting',
        currentCycle: 0,
        totalCycles: config.blockCycles,
        blocksCompleted: 0,
        accountCount: accountIds.length,
        logs: [],
        aborted: false,
        startedAt: Date.now()
    };
    
    addLog('danger', `Starting strike: ${target} | Mode: ${attackMode||'nuclear'} | ${accountIds.length} accounts | Reasons: ${(reasons||['spam']).join(',')}`);
    
    executeBlockCycle(operationId, target, accountIds, reportEnabled, reasons, rotateReasons !== false);
    
    res.json({ success: true, operationId, accountsUsed: accountIds.length });
});

app.get('/api/block/:id/status', (req, res) => {
    const { id } = req.params;
    const op = blockOperations[id];
    
    if (!op) return res.status(404).json({ error: 'Operation not found' });
    
    res.json({
        id: op.id,
        target: op.target,
        status: op.status,
        action: op.action,
        currentCycle: op.currentCycle,
        totalCycles: op.totalCycles,
        blocksCompleted: op.blocksCompleted,
        accountCount: op.accountCount,
        logs: op.logs.slice(-50),
        progress: Math.round((op.currentCycle / op.totalCycles) * 100)
    });
});

app.post('/api/block/:id/abort', (req, res) => {
    const { id } = req.params;
    if (blockOperations[id]) {
        blockOperations[id].aborted = true;
        blockOperations[id].status = 'aborted';
        addLog('warn', `Block operation ${id} aborted by admin`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Operation not found' });
    }
});

// ==================== VERIFY TARGET ====================

app.post('/api/verify', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    // Find first online account to verify with
    const onlineAcc = Object.values(accounts).find(a => a.status === 'online' && a.sock);
    if (!onlineAcc) {
        return res.status(400).json({ error: 'No online accounts to verify with' });
    }
    
    try {
        const [result] = await onlineAcc.sock.onWhatsApp(cleanPhone);
        if (result && result.exists) {
            addLog('info', `Target verified: ${cleanPhone} exists on WhatsApp as ${result.jid}`);
            res.json({ exists: true, jid: result.jid });
        } else {
            addLog('warn', `Target ${cleanPhone} NOT found on WhatsApp`);
            res.json({ exists: false });
        }
    } catch (err) {
        addLog('danger', `Verify failed for ${cleanPhone}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ==================== ADMIN CONFIG ENDPOINTS ====================

app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    const newConfig = req.body;
    config = { ...config, ...newConfig };
    addLog('info', 'Admin configuration updated');
    res.json({ success: true, config });
});

// ==================== LOGS ENDPOINTS ====================

app.get('/api/logs', (req, res) => {
    const { type, limit = 100 } = req.query;
    let filtered = logs;
    
    if (type && type !== 'all') {
        filtered = logs.filter(l => l.type === type);
    }
    
    res.json(filtered.slice(0, parseInt(limit)));
});

app.delete('/api/logs', (req, res) => {
    logs = [];
    addLog('info', 'Logs cleared by admin');
    res.json({ success: true });
});

// ==================== STATS ENDPOINT ====================

app.get('/api/stats', (req, res) => {
    const accountList = Object.values(accounts);
    res.json({
        totalAccounts: accountList.length,
        onlineAccounts: accountList.filter(a => a.status === 'online').length,
        offlineAccounts: accountList.filter(a => a.status === 'offline' || a.status === 'paused').length,
        warmingUp: accountList.filter(a => (a.warmupDay || 1) < config.warmupDays).length,
        bannedAccounts: accountList.filter(a => a.status === 'banned').length,
        totalProxies: proxies.length,
        aliveProxies: proxies.filter(p => p.status === 'alive').length,
        deadProxies: proxies.filter(p => p.status === 'dead').length,
        activeBlockOps: Object.values(blockOperations).filter(o => o.status === 'running').length
    });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     ☠️  ZENKAI CTRL v3.0.7 — ANTI-BAN EDITION  ☠️           ║
║                                                              ║
║     Server running on port ${PORT}                              ║
║     http://localhost:${PORT}                                    ║
║                                                              ║
║     ✓ Browser Fingerprint Rotation                           ║
║     ✓ Human-like Delay Patterns (Gaussian)                   ║
║     ✓ Presence Simulation Engine                             ║
║     ✓ Warm-up Period Enforcement                             ║
║     ✓ Anti-Detection Measures Active                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
    addLog('info', 'ZENKAI CTRL server started with anti-ban measures');
    addLog('info', 'Browser fingerprint rotation: ACTIVE');
    addLog('info', 'Human behavior simulation: ACTIVE');
    addLog('info', 'Warm-up enforcement: ACTIVE');
});
