const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
// パスワード自動生成用の機能を追加
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const upload = multer({ storage: multer.memoryStorage() });

// フォームデータを受け取るための設定を追加
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// --- データベースの再構築（3つのテーブルを作成） ---
const createTablesQuery = `
    -- 1. ルーム管理テーブル
    CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        login_id VARCHAR(50) UNIQUE NOT NULL,
        login_pass VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. アップ場所（カテゴリ）テーブル
    CREATE TABLE IF NOT EXISTS locations (
        id SERIAL PRIMARY KEY,
        room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. 写真保存テーブル（少し進化）
    CREATE TABLE IF NOT EXISTS new_photos (
        id SERIAL PRIMARY KEY,
        location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
        title VARCHAR(255),
        image_data BYTEA NOT NULL,
        mime_type VARCHAR(50) NOT NULL,
        uploaded_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`;
pool.query(createTablesQuery)
    .then(() => console.log('✅ 新しいデータベース構造の準備完了！'))
    .catch(err => console.error('テーブル作成エラー:', err));

// --- ランダムな文字列を作る関数 ---
function generateRandomString(length) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

// --- API: 管理画面用 ルームを作成してID/PASSを自動発行 ---
app.post('/api/admin/rooms', async (req, res) => {
    const roomName = req.body.roomName;
    if (!roomName) return res.status(400).send('ルーム名が必要です');

    const loginId = generateRandomString(6);   // 6文字のランダムID
    const loginPass = generateRandomString(8); // 8文字のランダムPASS

    try {
        const query = 'INSERT INTO rooms (name, login_id, login_pass) VALUES ($1, $2, $3) RETURNING *';
        const result = await pool.query(query, [roomName, loginId, loginPass]);
        res.json(result.rows[0]); // 作成したルーム情報を返す
    } catch (err) {
        console.error(err);
        res.status(500).send('ルームの作成に失敗しました');
    }
});

// --- API: 管理画面用 ルーム一覧とアップ場所を取得（★ここを上書き修正） ---
app.get('/api/admin/rooms', async (req, res) => {
    try {
        // ルームとアップ場所を両方データベースから取得
        const roomsResult = await pool.query('SELECT * FROM rooms ORDER BY created_at DESC');
        const locationsResult = await pool.query('SELECT * FROM locations ORDER BY created_at ASC');

        // ルームの中に、紐づくアップ場所のデータをくっつける
        const rooms = roomsResult.rows.map(room => {
            room.locations = locationsResult.rows.filter(loc => loc.room_id === room.id);
            return room;
        });
        res.json(rooms);
    } catch (err) {
        console.error(err);
        res.status(500).send('ルーム一覧の取得に失敗しました');
    }
});

// --- API: 管理画面用 指定したルームにアップ場所を作成（★これを新規追加） ---
app.post('/api/admin/locations', async (req, res) => {
    const roomId = req.body.roomId;
    const locationName = req.body.locationName;

    if (!roomId || !locationName) return res.status(400).send('ルームと場所名が必要です');

    try {
        const query = 'INSERT INTO locations (room_id, name) VALUES ($1, $2) RETURNING *';
        const result = await pool.query(query, [roomId, locationName]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('アップ場所の作成に失敗しました');
    }
});

// ==========================================
// 一般ユーザー用 API（ここから追加）
// ==========================================

// --- API: ログイン処理 ---
app.post('/api/login', async (req, res) => {
    const { loginId, loginPass } = req.body;

    // ★追加：管理者用の特別ログイン（IDとパスワードは自由に変更してください！）
    if (loginId === 'admin' && loginPass === 'admin123') {
        return res.json({ success: true, isAdmin: true });
    }

    try {
        const result = await pool.query('SELECT id, name FROM rooms WHERE login_id = $1 AND login_pass = $2', [loginId, loginPass]);
        if (result.rows.length > 0) {
            // 一般ユーザーの場合は isAdmin: false を返す
            res.json({ success: true, isAdmin: false, room: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'IDまたはパスワードが違います' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'サーバーエラー' });
    }
});

// --- API: 特定のルームの「アップ場所」リストを取得 ---
app.get('/api/locations/:roomId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM locations WHERE room_id = $1 ORDER BY created_at ASC', [req.params.roomId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('場所の取得に失敗しました');
    }
});

// --- API: 写真をアップロード（新しい箱 new_photos へ） ---
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).send('画像がありません');
    const { locationId, title, uploader } = req.body;
    const { mimetype, buffer } = req.file;
    try {
        const query = 'INSERT INTO new_photos (location_id, title, image_data, mime_type, uploaded_by) VALUES ($1, $2, $3, $4, $5)';
        await pool.query(query, [locationId, title || '無題', buffer, mimetype, uploader || '名無しさん']);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('アップロード失敗');
    }
});

// --- API: 特定の「アップ場所」の写真リストを取得 ---
app.get('/api/photos/:locationId', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, title, uploaded_by, created_at FROM new_photos WHERE location_id = $1 ORDER BY created_at DESC', [req.params.locationId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('写真の取得に失敗しました');
    }
});

// --- API: 画像データ本体を取得して表示 ---
app.get('/api/image/new/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT image_data, mime_type FROM new_photos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).send('Not Found');
        res.setHeader('Content-Type', result.rows[0].mime_type);
        res.send(result.rows[0].image_data);
    } catch (err) {
        res.status(500).send('画像読み込みエラー');
    }
});

// --- API: 写真の削除機能 ---
app.delete('/api/photos/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM new_photos WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: '削除に失敗しました' });
    }
});
// ==========================================
// 一般ユーザー用 API（ここまで追加）
// ==========================================

app.listen(port, () => console.log(`サーバー起動: http://localhost:${port}`));