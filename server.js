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

// --- データベースの自動アップデート（機能追加用） ---
const updateDbQuery = `
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
        ip_address VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`;
pool.query(updateDbQuery).catch(err => console.error('DBアプデエラー:', err));

const upload = multer({ storage: multer.memoryStorage() });
const archiver = require('archiver');

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

// --- API: 管理画面用 ルーム一覧とアップ場所（写真枚数付き）を取得 ---
app.get('/api/admin/rooms', async (req, res) => {
    try {
        const roomsResult = await pool.query('SELECT * FROM rooms ORDER BY id ASC');
        const locationsResult = await pool.query(`
            SELECT l.*, COUNT(p.id) as photo_count 
            FROM locations l 
            LEFT JOIN new_photos p ON l.id = p.location_id 
            GROUP BY l.id ORDER BY l.id ASC
        `);
        const rooms = roomsResult.rows.map(room => {
            room.locations = locationsResult.rows.filter(loc => loc.room_id === room.id);
            return room;
        });
        res.json(rooms);
    } catch (err) {
        console.error(err);
        res.status(500).send('取得失敗');
    }
});

// --- API: 管理画面用 指定したルームにアップ場所を【複数・一括】作成 ---
app.post('/api/admin/locations/bulk', async (req, res) => {
    const { roomId, locationNames } = req.body;

    if (!roomId || !locationNames || locationNames.length === 0) {
        return res.status(400).send('データが不足しています');
    }

    try {
        // 複数一気にデータベースに登録するためのSQL文を作る
        const values = [roomId];
        const placeholders = [];
        let count = 2;

        locationNames.forEach(name => {
            placeholders.push(`($1, $${count})`);
            values.push(name);
            count++;
        });
        
        const query = `INSERT INTO locations (room_id, name) VALUES ${placeholders.join(', ')}`;
        await pool.query(query, values);
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('一括作成に失敗しました');
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

// --- API: 管理画面用 場所の名前を変更（保存） ---
app.put('/api/admin/locations/:id', async (req, res) => {
    try {
        await pool.query('UPDATE locations SET name = $1 WHERE id = $2', [req.body.name, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('更新に失敗しました');
    }
});

// --- API: 管理画面用 場所を削除 ---
app.delete('/api/admin/locations/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM locations WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('削除に失敗しました');
    }
});

// --- API: 現場画面用 そのルームの全写真を一気に取得 ---
app.get('/api/photos/room/:roomId', async (req, res) => {
    try {
        const query = `
            SELECT np.id, np.location_id, np.title, np.uploaded_by, np.created_at
            FROM new_photos np
            JOIN locations l ON np.location_id = l.id
            WHERE l.room_id = $1
            ORDER BY np.created_at DESC
        `;
        const result = await pool.query(query, [req.params.roomId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('写真の取得に失敗');
    }
});

// --- API: 場所一覧を取得 (★修正：写真が何枚入っているかも一緒に数えて返す) ---
app.get('/api/locations/:roomId', async (req, res) => {
    try {
        const query = `
            SELECT l.id, l.name, COUNT(p.id) as photo_count 
            FROM locations l 
            LEFT JOIN new_photos p ON l.id = p.location_id 
            WHERE l.room_id = $1 
            GROUP BY l.id 
            ORDER BY l.id ASC
        `;
        const result = await pool.query(query, [req.params.roomId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('場所の取得に失敗');
    }
});

// --- API: 管理画面用 フォルダ一覧を「シートの通りに」完全同期 (★上書き) ---
app.put('/api/admin/locations/sync/:roomId', async (req, res) => {
    const roomId = req.params.roomId;
    const locations = req.body.locations; // [{id: 1, name: "1階"}, {id: null, name: "新規"}]

    try {
        const currentRes = await pool.query('SELECT id FROM locations WHERE room_id = $1', [roomId]);
        const currentIds = currentRes.rows.map(r => r.id);
        const incomingIds = locations.map(l => l.id).filter(id => id !== null);

        // ① シートから消された行（ID）をデータベースからも削除する
        const toDelete = currentIds.filter(id => !incomingIds.includes(id));
        for (const id of toDelete) {
            // ※念のためバックエンドでも「写真が入っていないか」を最終確認
            const pRes = await pool.query('SELECT count(*) FROM new_photos WHERE location_id = $1', [id]);
            if (parseInt(pRes.rows[0].count) === 0) {
                await pool.query('DELETE FROM locations WHERE id = $1', [id]);
            }
        }

        // ② 更新 または 新規追加
        for (const loc of locations) {
            if (!loc.name.trim()) continue; // 空欄は無視
            if (loc.id) {
                await pool.query('UPDATE locations SET name = $1 WHERE id = $2', [loc.name.trim(), loc.id]);
            } else {
                await pool.query('INSERT INTO locations (room_id, name) VALUES ($1, $2)', [roomId, loc.name.trim()]);
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('シートの保存に失敗しました');
    }
});

// --- API: 管理画面用 ルームを丸ごと削除する (★新規追加) ---
app.delete('/api/admin/rooms/:id', async (req, res) => {
    try {
        // 紐づく場所も写真もすべて道連れで削除されます（テーブル設定のCASCADE機能）
        await pool.query('DELETE FROM rooms WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('ルーム削除に失敗');
    }
});

// --- API: 管理画面用 IDとパスワードを再発行 ---
app.put('/api/admin/rooms/:id/credentials', async (req, res) => {
    // ランダムな英数字を生成
    const newId = Math.random().toString(36).substring(2, 8);
    const newPass = Math.random().toString(36).substring(2, 10);
    try {
        await pool.query('UPDATE rooms SET login_id = $1, login_pass = $2 WHERE id = $3', [newId, newPass, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('再発行失敗');
    }
});

// --- API: 管理画面用 ルームの停止・再開を切り替え ---
app.put('/api/admin/rooms/:id/toggle-active', async (req, res) => {
    try {
        await pool.query('UPDATE rooms SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('切替失敗');
    }
});

// --- API: 管理画面用 ログインログを取得 ---
app.get('/api/admin/rooms/:id/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT ip_address, created_at FROM login_logs WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('ログ取得失敗');
    }
});

// ==========================================
// 一般ユーザー用 API（ここから追加）
// ==========================================

// --- API: ログイン処理（停止チェック＆ログ記録を追加） ---
app.post('/api/login', async (req, res) => {
    const { loginId, loginPass } = req.body;
    if (loginId === 'admin' && loginPass === 'admin123') return res.json({ success: true, isAdmin: true });
    
    try {
        const result = await pool.query('SELECT * FROM rooms WHERE login_id = $1 AND login_pass = $2', [loginId, loginPass]);
        if (result.rows.length > 0) {
            const room = result.rows[0];
            
            // 停止フラグのチェック
            if (!room.is_active) {
                return res.status(403).json({ success: false, message: 'このルームは現在利用停止されています' });
            }

            // ログインログの記録
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '不明';
            await pool.query('INSERT INTO login_logs (room_id, ip_address) VALUES ($1, $2)', [room.id, ip]);

            res.json({ success: true, isAdmin: false, room: room });
        } else {
            res.status(401).json({ success: false, message: 'IDまたはパスワードが違います' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'サーバーエラー' });
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

// --- API: ルーム名を変更する ---
app.put('/api/admin/rooms/:id', async (req, res) => {
    try {
        await pool.query('UPDATE rooms SET name = $1 WHERE id = $2', [req.body.name, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('更新失敗');
    }
});

// --- API: 投稿済みの写真の「メモ（タイトル）」を変更する ---
app.put('/api/photos/:id/memo', async (req, res) => {
    try {
        await pool.query('UPDATE new_photos SET title = $1 WHERE id = $2', [req.body.title, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('更新失敗');
    }
});

// --- API: ルーム内の全写真をZIPで一括ダウンロード ---
app.get('/api/admin/rooms/:roomId/download', async (req, res) => {
    try {
        const query = `
            SELECT np.id, np.image_data, np.mime_type, np.title, l.name as loc_name
            FROM new_photos np
            JOIN locations l ON np.location_id = l.id
            WHERE l.room_id = $1
        `;
        const result = await pool.query(query, [req.params.roomId]);
        if (result.rows.length === 0) return res.status(404).send('写真がありません');

        res.attachment(`room_${req.params.roomId}_photos.zip`); // ダウンロードされるファイル名
        const archive = archiver('zip', { zlib: { level: 9 } }); // 圧縮レベル最大
        archive.pipe(res);

        // フォルダごとに分けてZIPに詰める
        result.rows.forEach((photo, index) => {
            const ext = photo.mime_type.split('/')[1] || 'jpg';
            // 例: "1階/写真_1.jpg" のようにフォルダ階層を作る
            const filename = `${photo.loc_name}/${photo.title || '無題'}_${photo.id}.${ext}`;
            archive.append(photo.image_data, { name: filename });
        });
        
        archive.finalize();
    } catch (err) {
        console.error(err);
        res.status(500).send('ZIP作成失敗');
    }
});

// ==========================================
// 一般ユーザー用 API（ここまで追加）
// ==========================================

app.listen(port, () => console.log(`サーバー起動: http://localhost:${port}`));