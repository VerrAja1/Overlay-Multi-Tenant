const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_FILE = path.join(DATA_DIR, 'database.json');
const MASTER_LICENSE = process.env.LICENSE_KEY || 'VERR-VIP-2026';

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
}

function readDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return { users: {} };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Helper untuk memastikan user lama tetap punya struktur categories
function ensureCategories(user) {
    if (!Array.isArray(user.settings.categories) || user.settings.categories.length === 0) {
        user.settings.categories = [
            { name: 'Reguler', minAmount: user.settings.minAmount || 10000 }
        ];
    }
    // Urutkan dari nominal tertinggi ke terendah agar matching akurat
    user.settings.categories.sort((a, b) => Number(b.minAmount) - Number(a.minAmount));
}

app.get('/', (req, res) => res.redirect('/daftar'));
app.get('/daftar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'daftar.html')));
app.get('/overlay/:username', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/admin/:username', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// API Pendaftaran Streamer Baru
app.post('/api/register', (req, res) => {
    const { license, username, password, webhookToken } = req.body;
    if (license !== MASTER_LICENSE) {
        return res.status(403).json({ error: 'Kode lisensi tidak valid!' });
    }
    const cleanUser = (username || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!cleanUser || !password) {
        return res.status(400).json({ error: 'Username (huruf/angka) dan password wajib diisi!' });
    }

    const db = readDB();
    if (db.users[cleanUser]) {
        return res.status(400).json({ error: 'Username sudah dipakai, pilih yang lain!' });
    }

    db.users[cleanUser] = {
        password,
        webhookToken: webhookToken || '',
        queue: [],
        settings: {
            title: 'ANTRIAN BY ONE',
            categories: [
                { name: 'VIP', minAmount: 25000 },
                { name: 'Reguler', minAmount: 10000 }
            ]
        }
    };
    writeDB(db);
    res.json({ success: true, username: cleanUser });
});

// API Login & Ambil Data Admin
app.post('/api/admin/:username/login', (req, res) => {
    const db = readDB();
    const user = db.users[req.params.username.toLowerCase()];
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    if (user.password !== req.body.password) return res.status(401).json({ error: 'Password salah' });
    ensureCategories(user);
    res.json({ success: true, queue: user.queue, settings: user.settings, webhookToken: user.webhookToken });
});

// API Kelola Antrian & Pengaturan
app.post('/api/admin/:username/queue', (req, res) => {
    const uname = req.params.username.toLowerCase();
    const db = readDB();
    const user = db.users[uname];
    if (!user || user.password !== req.body.password) return res.status(401).json({ error: 'Unauthorized' });

    ensureCategories(user);
    const { action, name, note, category, index, settings, webhookToken } = req.body;

    if (action === 'add' && name) {
        const defaultCat = user.settings.categories[user.settings.categories.length - 1]?.name || 'Reguler';
        user.queue.push({
            name,
            category: category || defaultCat,
            note: note || '',
            time: Date.now()
        });
    } else if (action === 'remove' && typeof index === 'number') {
        user.queue.splice(index, 1);
    } else if (action === 'clear') {
        user.queue = [];
    } else if (action === 'settings' && settings) {
        user.settings = { ...user.settings, ...settings };
        ensureCategories(user);
        if (typeof webhookToken === 'string') user.webhookToken = webhookToken;
    }

    writeDB(db);
    io.to(uname).emit('update_queue', { queue: user.queue, settings: user.settings });
    res.json({ success: true, queue: user.queue, settings: user.settings });
});

// Webhook SociaBuzz per Streamer (Auto-detect Kategori berdasarkan nominal)
app.post('/webhook/:username', (req, res) => {
    const uname = req.params.username.toLowerCase();
    const db = readDB();
    const user = db.users[uname];
    if (!user) return res.status(404).json({ error: 'Streamer tidak ditemukan' });

    const incomingToken = req.headers['x-sociabuzz-token'] || req.body.token || '';
    if (user.webhookToken && incomingToken && user.webhookToken !== incomingToken) {
        return res.status(403).json({ error: 'Token webhook tidak cocok' });
    }

    ensureCategories(user);
    const data = req.body;
    const supporter = data.supporter || data.donator_name || data.name || 'Player';
    const amount = Number(data.amount || data.price || 0);
    const message = data.message || data.note || '';

    // Cari kategori tertinggi yang syarat minAmount-nya terpenuhi
    const matchedCategory = user.settings.categories.find(cat => amount >= Number(cat.minAmount));

    if (matchedCategory) {
        user.queue.push({
            name: supporter,
            category: matchedCategory.name,
            note: message || `Rp${amount.toLocaleString('id-ID')}`,
            time: Date.now()
        });
        writeDB(db);
        io.to(uname).emit('update_queue', { queue: user.queue, settings: user.settings });
    }
    res.json({ received: true });
});

io.on('connection', (socket) => {
    socket.on('join_room', (username) => {
        const uname = (username || '').toLowerCase();
        socket.join(uname);
        const db = readDB();
        if (db.users[uname]) {
            ensureCategories(db.users[uname]);
            socket.emit('update_queue', {
                queue: db.users[uname].queue,
                settings: db.users[uname].settings
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server Multi-Tenant jalan di port ${PORT}`);
});
