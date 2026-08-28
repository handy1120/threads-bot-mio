require('dotenv').config();
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const RSSParser = require('rss-parser');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ── 設定 ─────────────────────────────────────────────
const THREADS_SESSION_ID = (process.env.THREADS_SESSION_ID || '').trim();
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const NOTIFY_EMAIL_FROM  = process.env.NOTIFY_EMAIL_FROM;
const NOTIFY_EMAIL_TO    = process.env.NOTIFY_EMAIL_TO;
const NOTIFY_EMAIL_PASS  = process.env.NOTIFY_EMAIL_PASS;
const RSS_URL            = 'https://note.com/mio_nekokaji/rss';
// 投稿済み記事の状態ファイル。git 管理下に置き、CI からコミットして永続化する。
// （以前は last_check.json を Actions cache に載せていたが、キャッシュが復元
//   できない日があると「新着ゼロ」を判定できず同じ記事を毎日投稿していた）
const STATE_FILE         = path.join(__dirname, 'posted.json');
const MAX_HISTORY        = 100;

// ── バリデーション ────────────────────────────────────
if (!THREADS_SESSION_ID) {
  console.error('❌ .env に THREADS_SESSION_ID を設定してください');
  console.error('   threads.com → F12 → Application → Cookies → sessionid の値');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('❌ .env に ANTHROPIC_API_KEY を設定してください');
  process.exit(1);
}

// ── クライアント初期化 ────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const rssParser = new RSSParser();

// ── メール通知 ────────────────────────────────────────
async function sendNotification(subject, body) {
  if (!NOTIFY_EMAIL_FROM || !NOTIFY_EMAIL_TO || !NOTIFY_EMAIL_PASS) return;
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: NOTIFY_EMAIL_FROM, pass: NOTIFY_EMAIL_PASS },
    });
    await transporter.sendMail({
      from: NOTIFY_EMAIL_FROM,
      to: NOTIFY_EMAIL_TO,
      subject,
      text: body,
    });
    console.log('📧 通知メール送信:', subject);
  } catch (e) {
    console.error('📧 メール送信失敗:', e.message);
  }
}

// ── 投稿済み状態（posted.json）の読み書き ──────────────
// URL のゆらぎ（クエリ・末尾スラッシュ）を吸収して同一記事を判定する
function normalizeUrl(url) {
  return (url || '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!Array.isArray(data.posted)) throw new Error('posted が配列ではありません');
    return data;
  } catch (e) {
    return null; // 未作成 or 壊れている
  }
}

function saveState(state) {
  state.posted = state.posted.slice(0, MAX_HISTORY);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ── RSSから未投稿の記事を取得 ─────────────────────────
async function fetchNewArticles(state) {
  console.log('📡 RSSを取得中:', RSS_URL);
  const feed = await rssParser.parseURL(RSS_URL);
  const postedUrls = new Set(state.posted.map(p => normalizeUrl(p.url)));

  const newItems = feed.items
    .filter(item => !postedUrls.has(normalizeUrl(item.link || item.url)))
    .sort((a, b) => {
      const dateA = new Date(a.pubDate || a.isoDate || 0);
      const dateB = new Date(b.pubDate || b.isoDate || 0);
      return dateB - dateA; // 新しい順にソート
    })
    .slice(0, 1); // 最新1件のみ処理
  console.log(`📰 未投稿記事: ${newItems.length} 件を処理 (投稿済み: ${postedUrls.size} 件)`);
  return newItems;
}

// ── 状態ファイルが無い場合は「全部新着」とせず、種まきして終了する ──
// 履歴を失った状態で走ると過去記事を再投稿してしまうため、安全側に倒す。
async function seedState() {
  console.log('⚠️  posted.json がありません。RSS の現行記事を投稿済みとして記録します。');
  const feed = await rssParser.parseURL(RSS_URL);
  const state = {
    lastCheck: new Date().toISOString(),
    posted: feed.items.map(i => ({
      url: normalizeUrl(i.link || i.url),
      title: i.title || '',
      postedAt: 'seed',
    })),
  };
  saveState(state);
  console.log(`✅ ${state.posted.length} 件を seed しました。今回は投稿しません。`);
}

// ── Anthropic APIでThreads投稿文を生成 ───────────────
async function generatePost(title, url) {
  console.log(`🤖 投稿文を生成中: "${title}"`);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 512,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: 'あなたはSNSマーケターです。与えられたnote記事のタイトルとURLを元に、Threads（SNS）向けの呼び込み投稿文を日本語で作成してください。\n\n【ルール】\n- 200文字以内で収める\n- 読者の興味を引くキャッチーな文章にする\n- URLは文末に含める（短縮しない）\n- ハッシュタグは1〜2個まで\n- 絵文字を適度に使う',
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `タイトル: ${title}\nURL: ${url}`,
      },
    ],
  });

  // thinking ブロック以外のテキストを取得
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

// ── Playwrightで投稿 ──────────────────────────────────
const COMPOSE_SELECTORS = [
  '[aria-label="作成"]',
  '[aria-label="新しいスレッド"]',
  '[aria-label="新しいスレッドを作成"]',
  '[aria-label="新規スレッドを作成"]',
  '[aria-label="Create"]',
  '[aria-label="Create new thread"]',
  '[aria-label="New thread"]',
  '[aria-label="Compose"]',
];


async function postToThreads(page, text) {
  // ポップアップ（「もっと発信しよう」など）を Escape で閉じてから操作する
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  let composed = false;

  // DOM 座標を取得してマウスクリック（Playwright ロケータが掴めない場合の対応）
  for (const selector of COMPOSE_SELECTORS) {
    const rect = await page.evaluate((sel) => {
      const elements = Array.from(document.querySelectorAll(sel));
      for (const el of elements) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    }, selector);

    if (rect) {
      console.log(`  🖱️ クリック試行: ${selector} at (${rect.x}, ${rect.y})`);
      await page.mouse.click(rect.x, rect.y);
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'debug_compose_0.5s.png' });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'debug_compose_1.5s.png' });
      console.log(`  ✅ コンポーズボタン発見: ${selector} at (${rect.x}, ${rect.y})`);
      composed = true;
      break;
    }
  }

  if (!composed) {
    const labels = await page.$$eval('[aria-label]', els =>
      els.map(el => el.getAttribute('aria-label')).filter(Boolean)
    );
    console.error('❌ コンポーズボタンが見つかりません。aria-label 一覧:');
    console.error(labels.join('\n'));
    await page.screenshot({ path: 'debug_no_compose.png' });
    throw new Error('コンポーズボタンが見つかりませんでした');
  }

  // モーダルが開くまで待機（最大10秒）
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'debug_after_compose_click.png' });
  console.log('  📸 コンポーズクリック後 → debug_after_compose_click.png');

  // ── テキスト入力 ──────────────────────────────────────
  // フィードにインラインエディタ（.first()）が存在するため、
  // モーダルが DOM 末尾に追加される仕様を利用して .last() で確実に取得する。

  // 1. モーダルの入力欄 = ページ最後の contenteditable
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible', timeout: 5000 });

  // 2. クリックしてフォーカスを明示的に当てる
  await editor.click();
  await page.waitForTimeout(500);

  // 3. 1文字ずつ入力（delay: 50ms でより自然なタイピングを再現）
  await page.keyboard.type(text, { delay: 50 });

  // 4. 入力後1秒待機してスクリーンショットで確認
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'debug_before_post.png' });
  console.log('  📸 投稿前スクリーンショット → debug_before_post.png');

  // 5. テキストが実際に入っているか確認
  const inputContent = await editor.innerText().catch(() => '');
  if (!inputContent.trim()) {
    await page.screenshot({ path: 'debug_empty_editor.png' });
    throw new Error('テキストが入力されていません（debug_empty_editor.png を確認してください）');
  }
  console.log(`  ✅ 入力確認 (${inputContent.length}文字): ${inputContent.substring(0, 30)}...`);

  // ── 送信：「投稿」に完全一致する要素の座標を取得してマウスクリック ──
  // Playwright ロケータ（locator().waitFor）は背後のフィードが動的に再描画
  // されるせいで安定せずタイムアウトすることがあるため、コンポーズボタンと
  // 同様に DOM 座標を取得して直接クリックする方式に統一する。
  // 「投稿」「Post」は完全一致のみ対象とし、「投稿オプション/Post Options」
  // のような部分一致を避ける。モーダルはDOM末尾に追加されるため、
  // 一致する要素のうち最後のものを採用する。
  const postRect = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('div[role="button"], button'));
    const matches = candidates.filter(el => {
      const t = el.innerText?.trim();
      return t === '投稿' || t === 'Post';
    });
    const target = matches[matches.length - 1];
    if (!target) return null;
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  if (!postRect) {
    // デバッグ：ボタン候補を全ダンプ
    const btnDump = await page.$$eval('div[role="button"], button', els =>
      els.map(el => ({ text: el.innerText?.trim().substring(0, 40), label: el.getAttribute('aria-label') }))
         .filter(el => el.text || el.label)
    );
    console.error('  🔍 ボタン候補:', JSON.stringify(btnDump, null, 2));
    await page.screenshot({ path: 'debug_no_submit.png' });
    throw new Error('送信ボタンが見つかりませんでした');
  }

  console.log(`  🖱️ 送信ボタンクリック試行: (${postRect.x}, ${postRect.y})`);
  await page.mouse.click(postRect.x, postRect.y);
  console.log('  ✅ モーダル内の送信ボタンをクリック');

  // 投稿ボタンを押した後、3秒待ってからスクリーンショット
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'debug_after_post.png' });
  console.log('  📸 投稿後スクリーンショット → debug_after_post.png');
}

// ── メイン処理 ────────────────────────────────────────
(async () => {
  // 1. 投稿済み状態を読み込む（無ければ seed して終了）
  const state = loadState();
  if (!state) {
    try {
      await seedState();
    } catch (err) {
      console.error('❌ RSS取得エラー:', err.message);
      process.exit(1);
    }
    process.exit(0);
  }

  // 2. 未投稿の記事を取得
  let newArticles;
  try {
    newArticles = await fetchNewArticles(state);
  } catch (err) {
    console.error('❌ RSS取得エラー:', err.message);
    process.exit(1);
  }

  if (newArticles.length === 0) {
    console.log('ℹ️  新着記事はありません。終了します。');
    state.lastCheck = new Date().toISOString();
    saveState(state);
    process.exit(0);
  }

  // 3. 各記事の投稿文を生成
  const posts = [];
  for (const item of newArticles) {
    const title = item.title || '（タイトルなし）';
    const url   = item.link  || item.url || '';
    try {
      const postText = await generatePost(title, url);
      console.log(`  生成済み (${postText.length}文字): ${postText.substring(0, 50)}...`);
      posts.push({ title, url, postText });
    } catch (err) {
      console.error(`  ❌ 生成失敗 "${title}":`, err.message);
    }
  }

  if (posts.length === 0) {
    console.log('⚠️  投稿文の生成に失敗しました。終了します。');
    process.exit(1);
  }

  // 4. Playwrightで投稿（sessionid クッキーで認証）
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  // sessionid クッキーを注入（url指定でdomain/path/secureを自動解決）
  const sessionIdValue = decodeURIComponent(THREADS_SESSION_ID);
  console.log(`🍪 SESSION_ID 文字数: 元=${THREADS_SESSION_ID.length} デコード後=${sessionIdValue.length}`);
  try {
    await context.addCookies([
      {
        name: 'sessionid',
        value: sessionIdValue,
        url: 'https://www.threads.com',
      },
    ]);
  } catch (err) {
    console.error('❌ addCookies失敗:', err.message);
    console.error('   先頭5文字コード:', [...sessionIdValue.slice(0, 5)].map(c => c.charCodeAt(0)));
    console.error('   末尾5文字コード:', [...sessionIdValue.slice(-5)].map(c => c.charCodeAt(0)));
    throw err;
  }

  const page = await context.newPage();

  try {
    console.log('🔑 セッションクッキーでログイン中...');
    await page.goto('https://www.threads.com/');
    await page.waitForTimeout(3000);

    if (page.url().includes('/login')) {
      await sendNotification(
        '【threads-bot-mio】セッション期限切れ',
        'THREADS_SESSION_ID が無効になりました。\n\nthreads.com にログイン後、F12 → Application → Cookies → sessionid の値を .env に再設定してください。'
      );
      throw new Error('セッションが無効です。.env の THREADS_SESSION_ID を更新してください');
    }
    console.log('✅ ログイン成功:', page.url());

    await page.screenshot({ path: 'debug_after_login.png' });
    console.log('  📸 ログイン後スクリーンショット → debug_after_login.png');

    // 各記事を投稿
    for (let i = 0; i < posts.length; i++) {
      const { title, url, postText } = posts[i];
      console.log(`\n📤 投稿 ${i + 1}/${posts.length}: "${title}"`);
      console.log(`   投稿文: ${postText}`);

      await postToThreads(page, postText);
      console.log(`   ✅ 投稿完了`);

      // 投稿できた時点ですぐ記録する（後続でコケても再投稿しないように）
      state.posted.unshift({ url: normalizeUrl(url), title, postedAt: new Date().toISOString() });
      state.lastCheck = new Date().toISOString();
      saveState(state);
      console.log(`   💾 posted.json に記録しました`);

      // 投稿後はホームへ遷移してコンポーザーの状態をリセット
      if (i < posts.length - 1) {
        console.log('   ⏳ ホームへ遷移して次の投稿を準備中 (5秒)...');
        await page.goto('https://www.threads.net/');
        await page.waitForTimeout(5000);
      }
    }

    console.log(`\n✅ 全 ${posts.length} 件の投稿が完了しました。`);

  } catch (err) {
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'debug_error.png' });
    console.error('📸 debug_error.png に保存しました');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
