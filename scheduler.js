require('dotenv').config();
const cron   = require('node-cron');
const { execFile } = require('child_process');
const fs     = require('fs');
const path   = require('path');

const LAST_CHECK_FILE = path.join(__dirname, 'last_check.json');
const LOG_FILE        = path.join(__dirname, 'log.txt');
const POST_SCRIPT     = path.join(__dirname, 'post.js');
const CATCH_UP_HOURS  = 24; // 何時間以上経過したら即実行するか

// ── ロガー ──────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

// ── 前回チェック時刻を読み込む ──────────────────────────
function loadLastCheck() {
  try {
    const data = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf8'));
    return new Date(data.lastCheck);
  } catch {
    return new Date(0); // ファイルなし → 未実行扱い
  }
}

// ── post.js を子プロセスで実行 ──────────────────────────
function runPost(reason) {
  log(`▶ post.js を起動 (理由: ${reason})`);
  const child = execFile(process.execPath, [POST_SCRIPT], { cwd: __dirname });

  child.stdout.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(line => log(`  ${line}`));
  });
  child.stderr.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(line => log(`  [ERR] ${line}`));
  });
  child.on('close', code => {
    log(`◀ post.js 終了 (exit: ${code})`);
  });
}

// ── 起動時チェック：24時間以上経過していたら即実行 ──────
function checkCatchUp() {
  const lastCheck  = loadLastCheck();
  const hoursSince = (Date.now() - lastCheck.getTime()) / (1000 * 60 * 60);
  log(`起動チェック: 前回実行から ${hoursSince.toFixed(1)} 時間経過`);

  if (hoursSince >= CATCH_UP_HOURS) {
    log(`⚠ ${CATCH_UP_HOURS}時間以上未実行のため即時実行します`);
    runPost('起動時キャッチアップ');
  } else {
    log(`✅ 前回実行から ${CATCH_UP_HOURS}時間未満のため即時実行はスキップ`);
  }
}

// ── cron スケジュール：毎日 6:00 (JST) ─────────────────
// pm2 / Windows は UTC 環境のため TZ を明示
process.env.TZ = 'Asia/Tokyo';

cron.schedule('0 6 * * *', () => {
  log('⏰ 定時実行トリガー (06:00 JST)');
  runPost('定時 06:00');
}, {
  timezone: 'Asia/Tokyo',
});

// ── 起動 ────────────────────────────────────────────────
log('=== threads-bot-mio scheduler 起動 ===');
log(`スケジュール: 毎日 06:00 JST に post.js を実行`);
checkCatchUp();
