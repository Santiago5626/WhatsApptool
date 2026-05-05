require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const session = require('express-session');
const { Client, LocalAuth } = require('whatsapp-web.js');
const logger = require('./utils/logger');
const multer = require('multer');
const XLSX = require('xlsx');
const app = express();

// Configurar multer para manejar archivos Excel
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/octet-stream',
            'application/excel',
            'application/x-excel',
            'application/x-msexcel',
            'application/vnd.ms-office',
            'application/msword',
            'application/vnd.oasis.opendocument.spreadsheet'
        ];
        
        const extension = path.extname(file.originalname).toLowerCase();
        const isExcelExtension = ['.xls', '.xlsx', '.csv', '.ods'].includes(extension);
        
        if (allowedTypes.includes(file.mimetype) || isExcelExtension) {
            cb(null, true);
        } else {
            cb(new Error('Formato de archivo no soportado. Por favor sube un archivo Excel (.xls, .xlsx)'));
        }
    }
});

app.use(express.json());
// Eliminado el static de aquí para protegerlo más abajo

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Variables globales
let client;
let qrCode = null;
let isAuthenticated = false;
let isCancelled = false;
let progressClient = null;
let initializationStatus = 'STARTING';
const SENT_LOG_PATH = path.join(__dirname, '..', 'sent_log.json');

// Asegurar que el log de enviados existe
async function initSentLog() {
    try {
        await fs.access(SENT_LOG_PATH);
    } catch {
        await fs.writeFile(SENT_LOG_PATH, JSON.stringify([]));
    }
}
initSentLog();

// Configuración de Sesiones y Usuarios
app.use(session({
    secret: process.env.SESSION_SECRET || 'whatsapp-bulk-messenger-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Cambiar a true si usas HTTPS en Render
}));

// Función para obtener usuarios de variables de entorno
function getAllowedUsers() {
    const usersEnv = process.env.ALLOWED_USERS || 'admin:admin123';
    const users = {};
    usersEnv.split(',').forEach(u => {
        const [username, password] = u.split(':');
        if (username && password) users[username] = password;
    });
    return users;
}

// Middleware de Autenticación
const requireAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        if (req.xhr || req.path.startsWith('/api/')) {
            res.status(401).json({ error: 'No autorizado' });
        } else {
            res.redirect('/login');
        }
    }
};

// Cargar configuración inicial
async function loadConfig() {
    try {
        const configData = await fs.readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(configData);
    } catch (error) {
        console.error('Error al cargar configuración:', error);
        return {
            numbers: [],
            message: "",
            qrTimeoutMs: 60000,
            delayBetweenMessagesMs: 1000,
            messagesBeforePause: 5,
            pauseDurationMinutes: 1
        };
    }
}

// Función para formatear número
function formatPhoneNumber(number) {
    if (!number) return null;
    
    let numberStr = typeof number === 'number' ? 
        Math.floor(number).toString() : 
        number.toString();
    
    const cleaned = numberStr.replace(/\D/g, '');
    
    if (cleaned.startsWith('57') && cleaned.length === 12) {
        return cleaned;
    }
    
    if (cleaned.length === 10) {
        return `57${cleaned}`;
    }
    
    return null;
}

// Inicializar cliente de WhatsApp
function initializeWhatsAppClient() {
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true, // headless: 'new' is default in newer puppeteer, but true works fine here
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-web-security',
                '--no-default-browser-check'
            ]
        }
    });

    client.on('qr', (qr) => {
        console.log('>>> Nuevo código QR generado y listo para escanear');
        qrCode = qr;
        isAuthenticated = false;
        initializationStatus = 'QR_READY';
    });

    client.on('ready', () => {
        console.log('>>> Cliente WhatsApp listo y conectado');
        isAuthenticated = true;
        qrCode = null;
        initializationStatus = 'CONNECTED';
    });

    client.on('loading_screen', (percent, message) => {
        console.log('>>> Cargando WhatsApp:', percent, '%', message);
        initializationStatus = `LOADING_${percent}`;
    });

    client.on('auth_failure', (msg) => {
        console.error('>>> Fallo de autenticación:', msg);
        isAuthenticated = false;
        qrCode = null;
        initializationStatus = 'AUTH_FAILURE';
    });

    client.on('disconnected', (reason) => {
        console.log('>>> Cliente desconectado:', reason);
        isAuthenticated = false;
        qrCode = null;
        initializationStatus = 'DISCONNECTED';
        setTimeout(() => {
            client = initializeWhatsAppClient();
        }, 5000);
    });

    client.initialize().catch(err => {
        console.error('Error al inicializar el cliente:', err);
    });

    return client;
}

// Inicializar el cliente por primera vez
client = initializeWhatsAppClient();

// Función para enviar actualización de progreso
function sendProgressUpdate(data) {
    if (progressClient) {
        progressClient.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// Rutas Públicas
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'login.html'));
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const allowedUsers = getAllowedUsers();
    
    if (allowedUsers[username] && allowedUsers[username] === password) {
        req.session.user = username;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
});

// --- EL MURO DE SEGURIDAD ---
app.use(requireAuth);

// Rutas y Archivos Protegidos (Solo accesibles después de login)
app.use(express.static(path.join(__dirname, 'ui')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
});

app.get('/api/sent-numbers', requireAuth, async (req, res) => {
    try {
        const data = await fs.readFile(SENT_LOG_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.json([]);
    }
});

app.post('/api/clear-sent-log', async (req, res) => {
    try {
        await fs.writeFile(SENT_LOG_PATH, JSON.stringify([]));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al limpiar el log' });
    }
});

app.get('/api/auth-status', (req, res) => {
    console.log('Estado actual:', { isAuthenticated, hasQR: !!qrCode });
    res.json({
        isAuthenticated,
        qrCode
    });
});

app.post('/api/logout', async (req, res) => {
    try {
        req.session.destroy();
        if (client) {
            console.log('Cerrando sesión de WhatsApp...');
            await client.destroy();
            
            const sessionDir = path.join(__dirname, '..', '.wwebjs_auth');
            try {
                await fs.rm(sessionDir, { recursive: true, force: true });
                console.log('Archivos de sesión eliminados');
            } catch (error) {
                console.error('Error al eliminar archivos de sesión:', error);
            }

            isAuthenticated = false;
            qrCode = null;

            setTimeout(() => {
                console.log('Inicializando nuevo cliente...');
                client = initializeWhatsAppClient();
            }, 1000);

            res.json({ success: true });
        } else {
            throw new Error('Cliente no inicializado');
        }
    } catch (error) {
        console.error('Error al cerrar sesión:', error);
        res.status(500).json({ error: 'Error al cerrar sesión' });
    }
});

app.get('/api/config', async (req, res) => {
    try {
        const config = await loadConfig();
        res.json(config);
    } catch (error) {
        console.error('Error al leer configuración:', error);
        res.status(500).json({ error: 'Error al leer configuración' });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        const { message, numbers } = req.body;
        const config = await loadConfig();
        
        if (message !== undefined) config.message = message;
        if (numbers !== undefined) config.numbers = numbers;
        
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        res.json({ success: true });
    } catch (error) {
        console.error('Error al guardar configuración:', error);
        res.status(500).json({ error: 'Error al guardar configuración' });
    }
});

app.post('/api/import-contacts', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se ha proporcionado ningún archivo' });
        }

        const workbook = XLSX.read(req.file.buffer, { 
            type: 'buffer',
            cellText: true,
            cellDates: false,
            cellNF: false,
            cellFormula: false
        });
        
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const range = XLSX.utils.decode_range(firstSheet['!ref']);
        
        for (let R = range.s.r; R <= range.e.r; ++R) {
            const cellAddress = XLSX.utils.encode_cell({r: R, c: 0});
            if (firstSheet[cellAddress]) {
                firstSheet[cellAddress].t = 's';
                firstSheet[cellAddress].v = firstSheet[cellAddress].v.toString();
            }
        }

        const rows = XLSX.utils.sheet_to_json(firstSheet, {
            header: 1,
            raw: false,
            defval: ''
        });

        const validNumbers = [];
        const invalidNumbers = [];

        rows.forEach((row, index) => {
            if (row[0]) {
                const number = row[0].toString().trim();
                const formattedNumber = formatPhoneNumber(number);
                if (formattedNumber) {
                    validNumbers.push(formattedNumber);
                } else {
                    invalidNumbers.push({
                        row: index + 1,
                        number: number,
                        reason: 'Formato inválido - debe tener 10 dígitos'
                    });
                }
            }
        });

        if (validNumbers.length === 0) {
            return res.status(400).json({
                error: 'No se encontraron números válidos',
                invalidNumbers: invalidNumbers
            });
        }

        const config = await loadConfig();
        config.numbers = [...new Set([...config.numbers, ...validNumbers])];
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        
        res.json({ 
            success: true, 
            imported: validNumbers.length,
            numbers: config.numbers,
            invalidNumbers: invalidNumbers,
            summary: {
                total: rows.length,
                valid: validNumbers.length,
                invalid: invalidNumbers.length
            }
        });
    } catch (error) {
        console.error('Error al procesar archivo Excel:', error);
        res.status(500).json({ 
            error: 'Error al procesar archivo Excel',
            details: error.message
        });
    }
});

app.get('/api/message-progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    progressClient = res;

    req.on('close', () => {
        progressClient = null;
    });
});

app.post('/api/cancel-messages', (req, res) => {
    isCancelled = true;
    res.json({ success: true });
});

app.post('/api/send-messages', async (req, res) => {
    try {
        if (!isAuthenticated) {
            return res.status(401).json({ error: 'No autenticado en WhatsApp' });
        }

        // Obtener datos del cuerpo de la petición o del config
        const { message: bodyMessage, numbers: bodyNumbers } = req.body;
        const config = await loadConfig();
        
        const finalMessage = bodyMessage || config.message;
        const finalNumbers = bodyNumbers || config.numbers;
        
        if (!finalMessage || !finalNumbers || finalNumbers.length === 0) {
            return res.status(400).json({ error: 'No hay mensaje o números configurados' });
        }

        // Actualizar config con los últimos datos usados
        config.message = finalMessage;
        config.numbers = finalNumbers;
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));

        // Enviar respuesta inmediata
        res.json({ success: true });

        // Reiniciar estado de cancelación
        isCancelled = false;

        // Procesar mensajes en lotes
        const batches = [];
        for (let i = 0; i < finalNumbers.length; i += config.messagesBeforePause) {
            batches.push(finalNumbers.slice(i, i + config.messagesBeforePause));
        }

        let successCount = 0;
        let errorCount = 0;

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            if (isCancelled) {
                sendProgressUpdate({
                    status: 'cancelled',
                    currentNumber: successCount + errorCount,
                    totalNumbers: finalNumbers.length,
                    currentBatch: batchIndex + 1,
                    totalBatches: batches.length,
                    successCount,
                    errorCount
                });
                return;
            }

            const batch = batches[batchIndex];
            
            for (let messageIndex = 0; messageIndex < batch.length; messageIndex++) {
                if (isCancelled) break;

                const number = batch[messageIndex];
                const currentNumber = batchIndex * config.messagesBeforePause + messageIndex + 1;

                try {
                    const chatId = number + '@c.us';
                    const isRegistered = await client.isRegisteredUser(chatId);
                    
                    if (isRegistered) {
                        await client.sendMessage(chatId, finalMessage);
                        successCount++;
                        
                        // Registrar como enviado con éxito
                        try {
                            const sentData = await fs.readFile(SENT_LOG_PATH, 'utf8');
                            const sentNumbers = JSON.parse(sentData);
                            if (!sentNumbers.includes(number)) {
                                sentNumbers.push(number);
                                await fs.writeFile(SENT_LOG_PATH, JSON.stringify(sentNumbers));
                            }
                        } catch (e) {
                            console.error('Error actualizando sent_log:', e);
                        }
                        
                    } else {
                        console.log(`Número no registrado: ${number}`);
                        errorCount++;
                    }
                    
                    sendProgressUpdate({
                        status: 'sending',
                        currentNumber,
                        totalNumbers: finalNumbers.length,
                        currentBatch: batchIndex + 1,
                        totalBatches: batches.length,
                        successCount,
                        errorCount
                    });

                    await new Promise(resolve => setTimeout(resolve, config.delayBetweenMessagesMs));
                } catch (error) {
                    console.error(`Error al enviar mensaje a ${number}:`, error);
                    errorCount++;
                }
            }

            if (!isCancelled && batchIndex < batches.length - 1) {
                const pauseMs = config.pauseDurationMinutes * 60 * 1000;
                const pauseEndTime = Date.now() + pauseMs;

                sendProgressUpdate({
                    status: 'paused',
                    currentNumber: (batchIndex + 1) * config.messagesBeforePause,
                    totalNumbers: finalNumbers.length,
                    currentBatch: batchIndex + 1,
                    totalBatches: batches.length,
                    successCount,
                    errorCount,
                    pauseEndTime
                });

                await new Promise(resolve => setTimeout(resolve, pauseMs));
            }
        }

        if (!isCancelled) {
            sendProgressUpdate({
                status: 'completed',
                currentNumber: finalNumbers.length,
                totalNumbers: finalNumbers.length,
                currentBatch: batches.length,
                totalBatches: batches.length,
                successCount,
                errorCount
            });
        }

    } catch (error) {
        console.error('Error al enviar mensajes:', error);
        if (progressClient) {
            sendProgressUpdate({
                status: 'error',
                error: 'Error al enviar mensajes'
            });
        }
    }
});

// Manejador de errores global para asegurar respuestas JSON
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Error interno del servidor',
        details: err.details || null
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
