const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// RenderのPostgreSQLへの接続設定
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // 環境変数から読み込むように変更
    ssl: { rejectUnauthorized: false }
});

// ファイルをディスクに保存せず、一時的にメモリに置く設定（DB直行のため）
const upload = multer({ storage: multer.memoryStorage() });

// publicフォルダの中身（HTMLなど）をブラウザに公開
app.use(express.static('public'));

// --- API: 写真をアップロードしてDBに保存 ---
app.post('/upload', upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).send('画像が選択されていません。');

    const { mimetype, buffer } = req.file;
    const title = req.body.title || '無題';
    const uploader = req.body.uploader || '名無しさん';

    try {
        const query = `
            INSERT INTO shared_photos (title, image_data, mime_type, uploaded_by)
            VALUES ($1, $2, $3, $4)
        `;
        await pool.query(query, [title, buffer, mimetype, uploader]);
        res.redirect('/'); // アップロード後、トップページに戻る
    } catch (err) {
        console.error(err);
        res.status(500).send('データベースへの保存に失敗しました。');
    }
});

// --- API: 写真のリスト（IDなどの情報）を取得 ---
app.get('/api/photos', async (req, res) => {
    try {
        // 画像データ自体は重いので、まずは情報だけを取得
        const result = await pool.query('SELECT id, title, uploaded_by, created_at FROM shared_photos ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('データ取得エラー');
    }
});

// --- API: DBから画像データを取り出して表示 ---
app.get('/api/image/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT image_data, mime_type FROM shared_photos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).send('画像が見つかりません');

        const img = result.rows[0];
        res.setHeader('Content-Type', img.mime_type); // 「これは画像ですよ」とブラウザに教える
        res.send(img.image_data); // バイナリデータを送信
    } catch (err) {
        res.status(500).send('画像読み込みエラー');
    }
});

app.listen(port, () => console.log(`サーバー起動: http://localhost:${port}`));